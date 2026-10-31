import { t } from '@chess-goat/shared';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { Tg } from '../tg/webapp';
import { useApp } from './context';

type Request = {
  title?: string;
  message: string;
  confirmLabel: string;
  /** Names the cancel button; Telegram's own Cancel when absent. */
  cancelLabel?: string;
  danger: boolean;
  /** False for a message with a single OK. */
  cancellable: boolean;
};

type Pending = Request & { resolve: (answer: boolean) => void };

const pending = signal<Pending | null>(null);
/** The client of the mounted <Dialogs />: questions go to its native popup when it has one. */
let host: Tg | null = null;

export type Choice<V extends string> = { value: V; label: string };

type ChoiceRequest = {
  title: string;
  message: string;
  choices: Choice<string>[];
  current: string;
};

const pendingChoice = signal<(ChoiceRequest & { resolve: (value: string | null) => void }) | null>(
  null,
);

/** The in-page list: Telegram below 6.2, or a client that refused the popup. */
function chooseInPage(request: ChoiceRequest): Promise<string | null> {
  pendingChoice.value?.resolve(null);
  return new Promise((resolve) => {
    pendingChoice.value = { ...request, resolve };
  });
}

/** The in-page bottom sheet: Telegram below 6.2, or a client that has no answer for us. */
function askInPage(request: Request): Promise<boolean> {
  pending.value?.resolve(false);
  return new Promise((resolve) => {
    pending.value = { ...request, resolve };
  });
}

function ask(request: Request): Promise<boolean> {
  const native = host?.showPopup({
    ...(request.title ? { title: request.title } : {}),
    message: request.message,
    buttons: request.cancellable
      ? [
          request.cancelLabel
            ? { id: 'cancel', type: 'default', text: request.cancelLabel }
            : { id: 'cancel', type: 'cancel' },
          {
            id: 'confirm',
            type: request.danger ? 'destructive' : 'default',
            text: request.confirmLabel,
          },
        ]
      : [{ id: 'confirm', type: 'ok' }],
  });
  // A rejection (anything but "another popup is already open") means the client refused the
  // call rather than the user declining it; fall back to the in-page sheet instead of reading
  // it as "no".
  if (native) return native.then((id) => id === 'confirm').catch(() => askInPage(request));
  return askInPage(request);
}

/** Cancel and one confirm action: Telegram's popup from 6.2, a bottom sheet below. */
export function confirmDialog(
  message: string,
  options: { confirmLabel?: string; danger?: boolean; title?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return ask({
    ...(options.title ? { title: options.title } : {}),
    ...(options.cancelLabel ? { cancelLabel: options.cancelLabel } : {}),
    message,
    confirmLabel: options.confirmLabel ?? t('app.game.confirm'),
    danger: options.danger ?? false,
    cancellable: true,
  });
}

/** A message with a single OK, such as the About box. */
export async function infoDialog(message: string, title?: string): Promise<void> {
  await ask({
    title,
    message,
    confirmLabel: t('app.common.ok'),
    danger: false,
    cancellable: false,
  });
}

/**
 * One of up to three choices (Telegram's popup takes at most three buttons): the native popup
 * from 6.2, with the current choice's text prefixed "✓ " because a popup button has no selected
 * state; the in-page list below. Resolves the picked value, or null when dismissed.
 */
export async function choiceDialog<V extends string>(request: {
  title: string;
  message: string;
  choices: Choice<V>[];
  current: V;
}): Promise<V | null> {
  const native = host?.showPopup({
    title: request.title,
    message: request.message,
    buttons: request.choices.map((choice) => ({
      id: choice.value,
      type: 'default',
      text: choice.value === request.current ? `✓ ${choice.label}` : choice.label,
    })),
  });
  // As in `ask`: a rejection is the client refusing the call, not the user dismissing it.
  const picked = native
    ? await native.catch(() => chooseInPage(request))
    : await chooseInPage(request);
  return request.choices.find((choice) => choice.value === picked)?.value ?? null;
}

export function Dialogs() {
  const { tg } = useApp();
  useEffect(() => {
    host = tg;
    return () => {
      if (host === tg) host = null;
    };
  }, [tg]);
  const choice = pendingChoice.value;
  if (choice) {
    const pick = (value: string | null) => {
      pendingChoice.value = null;
      choice.resolve(value);
    };
    return (
      <div class="dialog-backdrop" onClick={() => pick(null)}>
        <div class="dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
          <strong>{choice.title}</strong>
          <p>{choice.message}</p>
          <div class="choices" role="radiogroup">
            {choice.choices.map((option) => (
              <button
                key={option.value}
                class="choice"
                role="radio"
                aria-checked={option.value === choice.current}
                data-choice={option.value}
                onClick={() => pick(option.value)}
              >
                <span class="grow">{option.label}</span>
                {option.value === choice.current ? (
                  <span class="check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div class="actions">
            <button class="btn secondary" data-dialog="cancel" onClick={() => pick(null)}>
              {t('app.game.cancel')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const current = pending.value;
  if (!current) return null;
  const answer = (value: boolean) => {
    pending.value = null;
    current.resolve(value);
  };
  return (
    <div class="dialog-backdrop" onClick={() => answer(false)}>
      <div class="dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
        {current.title ? <strong>{current.title}</strong> : null}
        <p>{current.message}</p>
        <div class="actions">
          {current.cancellable ? (
            <button class="btn secondary" data-dialog="cancel" onClick={() => answer(false)}>
              {current.cancelLabel ?? t('app.game.cancel')}
            </button>
          ) : null}
          <button
            class={`btn ${current.danger ? 'danger' : ''}`}
            data-dialog="confirm"
            onClick={() => answer(true)}
          >
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
