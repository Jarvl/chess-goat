import { t, TIP_MAX_STARS, TIP_MIN_STARS, TipInvoiceDtoSchema } from '@chess-goat/shared';
import { useRef, useState } from 'preact/hooks';
import { AUTHOR_URL, BRAND } from '../brand';
import { useApp } from './context';
import { toast } from './toast';

const PRESETS = [100, 250, 500] as const;

type Source = number | 'custom';

/** Whole Stars from the custom field, or null while it is empty or out of range. */
export function customStars(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const stars = Number(raw);
  return stars >= TIP_MIN_STARS && stars <= TIP_MAX_STARS ? stars : null;
}

const Spinner = () => <span class="tip-spinner" aria-hidden="true" />;

/** Tip jar spec §3.2: presets, a custom amount, and Telegram's own payment sheet. */
export function SupportCard() {
  const { client, tg } = useApp();
  const [selected, setSelected] = useState<Source | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState<Source | null>(null);
  // State lags a render behind; the ref stops a second tap in the same tick.
  const inFlight = useRef(false);
  if (!tg.supports('invoice')) return null;

  const amount = customStars(raw);
  const state = raw === '' ? 'empty' : amount === null ? 'bad' : 'ok';
  const hint = {
    empty: t('app.settings.support.hint'),
    ok: t('app.settings.support.hint_ok'),
    bad: t('app.settings.support.hint_bad'),
  }[state];

  const tip = async (stars: number, source: Source) => {
    if (inFlight.current) return;
    inFlight.current = true;
    tg.haptic('light');
    setSelected(source);
    setBusy(source);
    try {
      const { url } = await client.post('/api/tips', { stars }, TipInvoiceDtoSchema);
      const status = await tg.openInvoice(url);
      if (status === 'paid') {
        tg.hapticNotify('success');
        toast(t('app.settings.support.thanks'));
        setSelected(null);
        setRaw('');
        setCustomOpen(false);
      } else if (status === 'failed') {
        tg.hapticNotify('error');
        toast(t('app.settings.support.failed'));
      }
    } catch {
      toast(t('app.common.error'));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const toggleCustom = () => {
    tg.hapticSelection();
    setSelected(customOpen ? null : 'custom');
    setCustomOpen(!customOpen);
  };

  const onInput = (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const digits = input.value.replace(/\D/g, '').slice(0, 5);
    // Written back directly too: when the digits are unchanged Preact skips the re-render.
    input.value = digits;
    setRaw(digits);
  };

  return (
    <div class="card" data-card="support">
      <div class="tip-intro">
        <span class="tip-head">{t('app.settings.support.title')}</span>
        <span class="tip-body">
          {t('app.settings.support.body_lead')}{' '}
          <button
            type="button"
            class="inline-link acc-text"
            data-action="support-author"
            onClick={() => tg.openTelegramLink(AUTHOR_URL)}
          >
            @{BRAND.author}
          </button>{' '}
          {t('app.settings.support.body')}
        </span>
      </div>
      <div class="tip-grid">
        {PRESETS.map((stars) => (
          <button
            type="button"
            key={stars}
            class={`tip${selected === stars ? ' on' : ''}`}
            data-tip={stars}
            aria-label={t('app.settings.support.preset_label', { stars })}
            aria-busy={busy === stars ? 'true' : undefined}
            disabled={busy !== null}
            onClick={() => void tip(stars, stars)}
          >
            {busy === stars ? (
              <Spinner />
            ) : (
              <>
                <span class="tip-star" aria-hidden="true">
                  ★
                </span>
                {stars}
              </>
            )}
          </button>
        ))}
        <button
          type="button"
          class={`tip-custom${customOpen ? ' on' : ''}`}
          data-action="tip-custom"
          aria-expanded={customOpen ? 'true' : 'false'}
          disabled={busy !== null}
          onClick={toggleCustom}
        >
          {t('app.settings.support.choose')}
        </button>
      </div>
      {customOpen && (
        <div class="tip-form">
          <div class="tip-row">
            <label class={`tip-input ${state}`}>
              <span class="tip-star" aria-hidden="true">
                ★
              </span>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder={t('app.settings.support.placeholder')}
                aria-label={t('app.settings.support.amount_label')}
                aria-invalid={state === 'bad' ? 'true' : undefined}
                aria-describedby="tip-hint"
                value={raw}
                onInput={onInput}
                data-tip-input
              />
            </label>
            <button
              type="button"
              class="tip-submit"
              data-action="tip-submit"
              aria-label={busy === 'custom' ? t('app.settings.support.tip') : undefined}
              aria-busy={busy === 'custom' ? 'true' : undefined}
              disabled={amount === null || busy !== null}
              onClick={() => {
                if (amount !== null) void tip(amount, 'custom');
              }}
            >
              {busy === 'custom' ? <Spinner /> : t('app.settings.support.tip')}
            </button>
          </div>
          <span class={`tip-hint ${state}`} id="tip-hint">
            {hint}
          </span>
        </div>
      )}
    </div>
  );
}
