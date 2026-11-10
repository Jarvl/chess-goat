import type { GroupRow, UserRow } from '../db/schema';
import type { Deps } from '../domain/deps';
import { getMember, markLeft, touchMember } from '../domain/members';
import type { TelegramApi } from './client';

const VERDICT_TTL_MS = 10 * 60_000;
/** A denial is cached briefly: enough to stop a request flood, short enough that a user who was just added is not locked out. */
const DENIAL_TTL_MS = 60_000;
const ADMIN_TTL_MS = 60_000;

/** The verification ladder and the admin check used on every settings request. */
export class Membership {
  private readonly admins = new Map<number, { until: number; ids: Set<number> }>();

  constructor(
    private readonly deps: Deps,
    private readonly api: TelegramApi,
  ) {}

  clearCaches(): void {
    this.admins.clear();
  }

  invalidateAdmins(groupId: number): void {
    this.admins.delete(groupId);
  }

  async verify(group: GroupRow, user: UserRow): Promise<boolean> {
    if (user.deletedAt || user.telegramUserId === null) return false;
    const member = await getMember(this.deps.db, group.id, user.id);
    if (member?.verifiedAt) {
      const ttl = member.status === 'member' ? VERDICT_TTL_MS : DENIAL_TTL_MS;
      if (Date.now() - member.verifiedAt.getTime() < ttl) return member.status === 'member';
    }
    try {
      const result = await this.api.getChatMember(group.telegramChatId, user.telegramUserId);
      const present =
        result.status === 'member' ||
        result.status === 'administrator' ||
        result.status === 'creator' ||
        (result.status === 'restricted' && result.is_member);
      if (present) {
        await touchMember(this.deps.db, group.id, user.id, { verified: true });
        return true;
      }
      await markLeft(this.deps.db, group.id, user.id, { verified: true });
      return false;
    } catch (error) {
      this.deps.log.debug(
        { err: error, groupId: group.id },
        'getChatMember failed; using own evidence',
      );
      return member?.status === 'member';
    }
  }

  async isAdmin(group: GroupRow, user: UserRow): Promise<boolean> {
    if (user.telegramUserId === null) return false;
    const cached = this.admins.get(group.id);
    if (cached && cached.until > Date.now()) return cached.ids.has(user.telegramUserId);
    try {
      const admins = await this.api.getChatAdministrators(group.telegramChatId);
      const ids = new Set(admins.map((admin) => admin.user.id));
      this.admins.set(group.id, { until: Date.now() + ADMIN_TTL_MS, ids });
      return ids.has(user.telegramUserId);
    } catch (error) {
      this.deps.log.warn({ err: error, groupId: group.id }, 'getChatAdministrators failed');
      return false;
    }
  }
}
