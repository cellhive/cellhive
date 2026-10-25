# ADR-0030: Chống spam form không dùng dịch vụ ngoài

- Trạng thái: Accepted
- Ngày: 2026-09-24
- Thay thế / sửa: SPEC §8 (Form: "captcha đơn giản"), CONTRACTS §17 (T306)

## Bối cảnh

SPEC §8 yêu cầu form công khai có "captcha đơn giản" và rate limit 10 lần/phút/IP (Quyết định S3 #5). Quy tắc vàng #6 cấm gọi dịch vụ ngoài bắt buộc, nên reCAPTCHA/hCaptcha/Turnstile bị loại. Captcha tự vẽ (ảnh chữ, phép cộng) vừa kém truy cập (a11y), vừa bị OCR/LLM vượt dễ, và cần state phía server hoặc thư viện ảnh.

## Quyết định

Ba lớp, đều trong server, không cần tương tác thêm của người điền:

1. **Submit token ký, có thời gian điền tối thiểu.** `GET /shares/:token/submit-token` trả `v1.<ms phát hành>.<nonce 16 byte>.<HMAC-SHA256>`; HMAC phủ phiên bản, id link, thời điểm và nonce, khoá dẫn xuất HKDF từ `SESSION_SECRET` (mục đích `form-submit-token`). Submit phải mang token của **đúng link**, cũ ít nhất 3 giây (bot gửi ngay khi tải trang) và không quá 24 giờ. Nonce được "claim" bằng `SET NX` trong Valkey (TTL 24h) nên mỗi token chỉ tạo được một record; lần gửi thất bại (lỗi validate) nhả nonce để người dùng sửa và gửi lại. Không lưu gì trong DB; Valkey lỗi → `503` (fail closed như các rate limit khác).
2. **Honeypot.** Body có key `honeypot` ứng với một ô người thật không thấy; khác rỗng → trả `200` như thành công nhưng không ghi gì, để bot không học được.
3. **Rate limit và kích thước.** 10 lần/phút/IP (IP qua `TRUSTED_PROXIES`) cho route link, 10 lần/phút/user cho route thành viên (tránh chặn cả văn phòng chung NAT); body ≤ 256 KiB.

## Phương án đã cân nhắc

- **Captcha bên thứ ba**: vi phạm quy tắc vàng #6, lộ IP người điền cho bên ngoài.
- **Captcha ảnh/toán tự làm**: kém a11y, dễ vượt bằng OCR/LLM, cần state.
- **Proof-of-work phía trình duyệt**: tốn pin điện thoại, không ngăn được bot có tài nguyên; có thể thêm sau nếu đo thấy cần (token hiện tại có trường phiên bản `v1`).

## Hệ quả

- Client (T315/T317) lấy token khi hiển thị form và gửi kèm; lỗi `SUBMITTED_TOO_FAST` có `retry_after_ms`, `SUBMIT_TOKEN_INVALID` → tải token mới.
- Đổi `SESSION_SECRET` làm mất hiệu lực các token đang mở (người dùng tải lại form).
- Không chặn được spam do người thật; khi cần, admin tắt/tạo lại link, bật `require_login` hoặc giới hạn nộp theo người.
