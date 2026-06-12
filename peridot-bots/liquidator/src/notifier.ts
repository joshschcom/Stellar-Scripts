/**
 * Minimal Telegram notifier. Disabled (no-op) unless both TELEGRAM_BOT_TOKEN
 * and TELEGRAM_CHAT_ID are configured. Never throws — a Telegram outage must
 * not affect bot operation.
 */
export class TelegramNotifier {
  private readonly enabled: boolean;
  private readonly lastAlertAt = new Map<string, number>();

  constructor(
    private readonly token?: string,
    private readonly chatId?: string,
    /** Minimum gap between alerts sharing the same key (anti-spam). */
    private readonly alertThrottleMs = 30 * 60_000,
  ) {
    this.enabled = Boolean(token && chatId);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async send(text: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: text.slice(0, 4000),
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        console.error(`[telegram] sendMessage failed: ${res.status} ${await res.text()}`);
      }
    } catch (error) {
      console.error(`[telegram] send failed: ${(error as Error).message}`);
    }
  }

  /** Like send(), but messages with the same key are throttled. */
  async alert(key: string, text: string): Promise<void> {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - (this.lastAlertAt.get(key) ?? 0) < this.alertThrottleMs) return;
    this.lastAlertAt.set(key, now);
    await this.send(text);
  }
}
