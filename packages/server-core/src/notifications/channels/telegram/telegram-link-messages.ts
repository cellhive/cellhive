/**
 * The fixed replies of the notification bot to `/start` and `/stop` (BACKLOG
 * T549, CONTRACTS §22.7), in English and Vietnamese. They carry no data at
 * all — no organization, user, base or record — so a chat that is not (or no
 * longer) linked learns nothing from them. Plain text: nothing to escape for
 * `parse_mode=HTML`.
 */

export type TelegramLinkReply = 'linked' | 'invalid' | 'stopped';

const REPLIES: Readonly<Record<'en' | 'vi', Readonly<Record<TelegramLinkReply, string>>>> = {
  en: {
    linked:
      'Linked. You will receive your Cellhive notifications in this chat. Send /stop to unlink.',
    invalid:
      'This link is not valid or has expired. Create a new one in Cellhive, in your ' +
      'notification settings.',
    stopped: 'Unlinked. You will no longer receive Cellhive notifications in this chat.',
  },
  vi: {
    linked:
      'Đã liên kết. Bạn sẽ nhận thông báo Cellhive trong cuộc trò chuyện này. Gửi /stop để ' +
      'huỷ liên kết.',
    invalid:
      'Link không hợp lệ hoặc đã hết hạn. Hãy tạo link mới trong Cellhive, ở phần cài đặt ' +
      'thông báo.',
    stopped: 'Đã huỷ liên kết. Bạn sẽ không nhận thông báo Cellhive trong cuộc trò chuyện này nữa.',
  },
};

/** `vi` for a Vietnamese locale (`vi`, `vi-VN`…), else `en`. */
export function replyLanguageOf(locale: string | null | undefined): 'en' | 'vi' {
  return typeof locale === 'string' && /^vi(?:[-_]|$)/iu.test(locale) ? 'vi' : 'en';
}

export function telegramLinkReply(reply: TelegramLinkReply, locale: string | null): string {
  return REPLIES[replyLanguageOf(locale)][reply];
}
