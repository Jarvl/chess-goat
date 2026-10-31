import {
  MOVE_CONFIRMATIONS,
  PrefsSchema,
  t,
  type MessageKey,
  type MoveConfirmations,
  type Prefs,
} from '@chess-goat/shared';
import { useEffect } from 'preact/hooks';
import { z } from 'zod';
import { AUTHOR_URL, BRAND, REPO_URL } from '../../brand';
import { loadMyFlair, myFlair, unlockedPercent } from '../../state/flair';
import { prefs } from '../../state/session';
import { useApp } from '../context';
import { Switch } from '../controls';
import { choiceDialog, confirmDialog, infoDialog } from '../dialog';
import { Flair } from '../Flair';
import { SupportCard } from '../SupportCard';
import { toast } from '../toast';

const PrefsResponseSchema = z.object({ prefs: PrefsSchema, dmAllowed: z.boolean() });
const TOGGLES: {
  key: keyof Pick<Prefs, 'notifications'>;
  label: 'app.settings.notifications';
}[] = [{ key: 'notifications', label: 'app.settings.notifications' }];

const CONFIRMATION_LABEL: Record<MoveConfirmations, MessageKey> = {
  always: 'app.settings.move_confirmations.always',
  people: 'app.settings.move_confirmations.people',
  never: 'app.settings.move_confirmations.never',
};

export function Settings() {
  const { client, tg, router } = useApp();
  const current = prefs.value;
  const flair = myFlair.value;
  // Fills in the Flair row's share unlocked and worn emojis. A failed load leaves the row as it
  // is: it keeps working, and the Flair screen shows its own error (flair spec §5.2).
  useEffect(() => {
    void loadMyFlair(client).catch(() => undefined);
  }, [client]);
  // Turn notifications are DMs, which need the user's leave (spec §6.1 step 4).
  const askToMessage = async () => {
    const granted = await tg.requestWriteAccess();
    if (granted === null) return;
    await client.put('/api/me/prefs', { writeAccess: { allowed: granted } }).catch(() => undefined);
  };
  const update = async (patch: Partial<Prefs>) => {
    const previous = prefs.value;
    prefs.value = { ...previous, ...patch };
    try {
      const response = await client.put('/api/me/prefs', { prefs: patch }, PrefsResponseSchema);
      prefs.value = response.prefs;
      if (patch.notifications === true && !response.dmAllowed) await askToMessage();
    } catch {
      prefs.value = previous;
      toast(t('app.common.error'));
    }
  };
  const pickConfirmations = async () => {
    const picked = await choiceDialog({
      title: t('app.settings.move_confirmations'),
      message: t('app.settings.move_confirmations_help'),
      choices: MOVE_CONFIRMATIONS.map((value) => ({ value, label: t(CONFIRMATION_LABEL[value]) })),
      current: prefs.value.moveConfirmations,
    });
    if (picked === null || picked === prefs.value.moveConfirmations) return;
    tg.hapticSelection();
    await update({ moveConfirmations: picked });
  };
  const remove = async () => {
    if (
      !(await confirmDialog(t('app.settings.delete_confirm'), {
        confirmLabel: t('app.settings.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await client.del('/api/me');
      toast(t('app.settings.deleted'));
      tg.close();
    } catch {
      toast(t('app.common.error'));
    }
  };
  return (
    <div class="screen">
      <h1 class="title">{t('app.settings.title')}</h1>
      <div class="card">
        <button
          class="field pick"
          data-action="flair"
          onClick={() => router.push({ name: 'flair' })}
        >
          <span class="grow">
            <span class="primary">{t('app.settings.flair')}</span>
            {flair ? (
              <span class="secondary">
                {t('app.settings.flair_unlocked', { percent: unlockedPercent(flair) })}
              </span>
            ) : null}
          </span>
          {flair ? <Flair ids={flair.worn} /> : null}
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button
          class="field pick"
          data-pref="moveConfirmations"
          onClick={() => void pickConfirmations()}
        >
          <span class="grow">{t('app.settings.move_confirmations')}</span>
          <span class="value">{t(CONFIRMATION_LABEL[current.moveConfirmations])}</span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
        {TOGGLES.map(({ key, label }) => (
          <div class="field" key={key}>
            <span>{t(label)}</span>
            <Switch
              checked={current[key]}
              onChange={(value) => void update({ [key]: value })}
              data-pref={key}
              label={t(label)}
            />
          </div>
        ))}
      </div>
      <SupportCard />
      <div class="card">
        <img class="banner-img" src={BRAND.bannerUrl} alt="" loading="lazy" />
        <button
          class="link-row"
          data-action="author"
          onClick={() => tg.openTelegramLink(AUTHOR_URL)}
        >
          <span class="grow">
            <span class="primary">
              {t('app.settings.made_by')} <span class="acc-text">@{BRAND.author}</span>
            </span>
            <span class="secondary">{t('app.settings.made_by_sub')}</span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button class="link-row" data-action="source" onClick={() => tg.openLink(REPO_URL)}>
          <span class="grow">
            <span class="primary">{t('app.settings.source')}</span>
            <span class="secondary">{BRAND.repository}</span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button
          class="link-row"
          data-action="about"
          onClick={() => void infoDialog(t('app.settings.about'), t('app.settings.about_title'))}
        >
          <span class="grow">
            <span class="primary">{t('app.settings.about_row')}</span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
      </div>
      <button class="card danger-row" data-action="delete" onClick={() => void remove()}>
        {t('app.settings.delete')}
      </button>
    </div>
  );
}
