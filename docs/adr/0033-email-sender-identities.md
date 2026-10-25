# ADR-0033: Danh tính gửi email (sender identities), chữ ký và chính sách footer

- Trạng thái: Accepted (2026-10-17, T528 — người review đã chốt các điểm của ADR trong BACKLOG "Quyết định S5", "Quyết định S5 email", "Quyết định S5 thiết kế" và các bổ sung T531–T534; QA S5 M7 chốt khi hồi cứu)
- Ngày: 2026-10-05
- Sửa: SPEC §5.10 (bảng `email_identities` kèm cấu hình SMTP riêng, `email_identity_bases`, `email_identity_verifications`; `organizations.settings.email`), §11.5 (`send_email`), §20 (`SMTP_ALLOWED_FROM_DOMAINS`, `EMAIL_AUTOMATION_FOOTER`, `SMTP_ALLOW_PRIVATE_HOSTS`), §14.3 (SSRF cho host SMTP); CONTRACTS §1.2 (prefix `eid`), §6, §8 (`email_identity.*`), §23. Làm rõ ADR-0025 §8 (không đổi ý chính). Nguồn: `docs/reviews/S5-email-research.md` §2–§4, §7–§8; BACKLOG "Quyết định S5" #1, #9 và "Quyết định S5 email" #1–#3, #6.

## Bối cảnh

ADR-0025 §8 nói `send_email` dùng "cấu hình SMTP của org", không gửi dưới danh nghĩa `run_as`. SPEC §20 chỉ có SMTP cấp instance (`SMTP_URL`, `SMTP_FROM`), và S5 chốt chỉ dùng SMTP instance (Quyết định S5 #1). Người dùng cần gửi thư nhân danh hộp thư chung (Phòng Nhân sự `hr@`, IT `it@`) chứ không phải địa chỉ hệ thống, kèm chữ ký của hộp thư đó.

Gửi `From: hr@corp.vn` qua một relay không ký DKIM cho `corp.vn` làm DMARC thất bại (thư bị chặn nếu domain có `p=reject`). Cho người quản lý automation tự đặt `From` hoặc Reply-To tuỳ ý mở đường giả mạo/phishing. Hệ thống helpdesk (Zammad, HubSpot, Freshdesk) gắn địa chỉ gửi và chữ ký với hộp thư/nhóm do quản trị khai báo và xác minh; Gmail "Send mail as" và Mailchimp xác minh bằng thư có link/mã.

Footer nguồn giúp người nhận biết thư tự động và giúp người vận hành instance truy nguồn, nhưng footer đầy đủ lộ tên base/automation nội bộ ra ngoài.

## Quyết định

### 1. Danh tính gửi

- `meta.email_identities` (prefix `eid`, FK ghép `(organization_id, …)`): `email` (chữ thường, duy nhất trong org), `display_name` (≤ 100 ký tự, bỏ ký tự điều khiển), `reply_to` mặc định, `transport` (`system` | `smtp`, mục 1A), `mode`, `status` (`pending | verified | error | disabled`), `verified_at`, `verified_via` (`link | code`), `base_scope` (`all | selected`, kèm `meta.email_identity_bases`), `signature_md`.
- *Bổ sung 2026-10-17 (BACKLOG "Quyết định S5b" #1, T540 — QA S5 M7)*: `display_name` còn từ chối `@`, `<`, `>`, ký tự điều khiển/định hướng và chuỗi giống URL/tên miền (`422 VALIDATION_FAILED` / `DISPLAY_NAME_NOT_ALLOWED`); tên lưu trước đó giữ nguyên, được gắn cờ `display_name_issue` — chi tiết CONTRACTS §23.3.
- **Quản lý**: chỉ org owner/admin (tạo, xác minh, sửa, tắt, xoá). Workspace admin và base admin không được.
- **Dùng**: người quản lý automation của một base (ADR-0025) chọn được danh tính `verified`, chưa tắt, có base trong phạm vi. Mọi trường hợp khác (chưa xác minh, tắt, ngoài phạm vi, không tồn tại, org khác) trả **cùng** lỗi `EMAIL_IDENTITY_NOT_USABLE` — không phân biệt để không lộ tồn tại. Hạn chế theo group (`allowed_group_ids`) là P1.
- **Chế độ gửi** do server tính, người dùng không tự chọn (transport `smtp` luôn `send_as`, mục 1A; dưới đây là transport `system`):
  - `send_as`: domain của địa chỉ thuộc env `SMTP_ALLOWED_FROM_DOMAINS` (mặc định domain của `SMTP_FROM`) → `From: "<tên>" <địa chỉ>`.
  - `on_behalf`: còn lại → `From: "<tên> (qua Cellhive)" <SMTP_FROM>`, `Reply-To: <địa chỉ>`. Giữ căn chỉnh DMARC (From thuộc domain hệ thống) như Airtable "via" và Mailchimp.
  - Không đặt header `Sender` ở cả hai chế độ. Builder và xem trước hiện rõ chế độ và thư sẽ hiển thị thế nào; không viết lại âm thầm.
- **`From`** của thư automation chỉ là `SMTP_FROM` (người gửi hệ thống) hoặc một danh tính `verified`. Không bao giờ là email `run_as`, giá trị field hay literal (giữ ý ADR-0025 §8).
- **Reply-To** chỉ là một danh tính đã xác minh hoặc email của user Cellhive (field `user`, người bấm nút `clicked_by`, `run_as`). Không literal hoặc field text ở S5. Giới hạn này áp cho Reply-To **của action** `send_email` (T514). `reply_to` mặc định **của danh tính** do org owner/admin đặt (người được tin cậy, cùng quyền khai báo danh tính) nên nhận mọi địa chỉ hợp lệ (parse từng địa chỉ, IDN → punycode) — *chốt 2026-10-05, T530*.
- **Người gửi hệ thống** cho automation: được dùng mặc định; org admin tắt được (`organizations.settings.email.system_sender_enabled = false`) để buộc mọi thư automation đi qua danh tính.
- **Danh tính bị tắt/xoá/thu hẹp phạm vi**: step `failed` (`email_identity_unavailable`), không rơi về người gửi hệ thống; automation **không** tự tắt (khác `run_as_lost_access`); run lỗi tính vào circuit breaker như thường.
- **Transport**: `system` (SMTP instance) hoặc `smtp` (máy chủ riêng của danh tính, mục 1A) — cả hai ở S5. SMTP cấp org là P1; OAuth Microsoft 365/Gmail là P2. Không có SMTP riêng **từng action**.

### 1A. SMTP riêng của danh tính (transport `smtp`)

- Cấu hình: `host`, `port` (chỉ 25, 465, 587, 2525), `security` (`starttls` | `tls` | `none`), `username`, `password`. `none` chỉ khi org admin chọn tường minh, có cảnh báo và audit; mặc định TLS bắt buộc.
- **Mật khẩu**: mã hoá AES-256-GCM bằng khoá dẫn xuất riêng mục đích từ `APP_MASTER_KEY` (HKDF, `info` riêng như ADR-0027), dùng chung helper (`sealSecret`/`unsealSecret`, `deriveSecretKey`) với `meta.secrets` và response idempotency. **Lưu ở cột `meta.email_identities.smtp_password_enc`** (không phải `meta.secrets` — bảng đó có từ T516 cho token bot Telegram, nhưng mật khẩu SMTP đi cùng host/tên đăng nhập của danh tính và đổi thì phải xác minh lại; mật khẩu gắn 1-1 với danh tính, xoá theo danh tính) — *chốt 2026-10-05, T530*. Chỉ ghi: API không bao giờ trả lại (chỉ `password_set`), UI hiện "đã lưu"; đổi bằng cách nhập lại; không bao giờ log, không nằm trong audit/lỗi. Chỉ org owner/admin xem/sửa cấu hình SMTP; người quản lý automation chỉ thấy `id`, `email`, `display_name`, `mode`.
- **SSRF**: host được resolve rồi chặn địa chỉ private, loopback, link-local, metadata (vd `169.254.169.254`) — kiểm lúc lưu **và mỗi lần kết nối** (chống DNS rebinding), trừ khi env `SMTP_ALLOW_PRIVATE_HOSTS=true` cho instance tự host trong LAN (vd `mail.example.lan`). Địa chỉ metadata cloud (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`) cùng địa chỉ không xác định/multicast/dành riêng **luôn** bị chặn, kể cả khi `SMTP_ALLOW_PRIVATE_HOSTS=true` — *chốt 2026-10-05, T530*. Timeout kết nối/greeting/socket; rate limit gửi theo danh tính cộng trần của org.
- **Xác minh** ("Kiểm tra & xác minh"): SMTP AUTH thành công **và** gửi một thư **từ** địa chỉ danh tính **tới** chính địa chỉ đó qua máy chủ đó, chứa link + mã 6 số (như mục 2). Chứng minh cả quyền đăng nhập lẫn sở hữu hộp thư. Đổi `host`, `username` hoặc `password` → `pending`, phải xác minh lại.
- **Chế độ** luôn `send_as` (`From` = địa chỉ danh tính). Căn chỉnh DMARC là trách nhiệm của quản trị mail; UI hiện gợi ý SPF/DKIM. Microsoft 365/Gmail ngày càng chặn SMTP AUTH cơ bản — dùng app password nơi được phép; OAuth là P2.
- **Lỗi xác thực lặp lại** khi gửi → danh tính `status = error` kèm lý do; step dùng nó `failed` (`email_identity_auth_failed`) với lý do rõ; automation **không** tự tắt. Org admin sửa thông tin và xác minh lại để về `verified`.
- Audit `email_identity.credentials_changed` (host/port/security/username đổi, cờ `password_changed`; không bao giờ giá trị bí mật) và `email_identity.error`.

### 2. Xác minh quyền sở hữu

- Tạo danh tính hoặc đổi `email`/`transport` (với `smtp`: cả `host`/`username`/`password`) → `pending`, gửi thư xác nhận **qua chính transport** danh tính sẽ dùng (kiểm cùng lúc quyền sở hữu hộp thư và việc transport chấp nhận `From` đó). Đổi tên, Reply-To, chữ ký, phạm vi không cần xác minh lại.
- Thư có **link** và **mã 6 số**; nội dung cố định, không có văn bản do người dùng nhập ngoài tên hiển thị (chỉ trong thân thư, đã escape).
- Tên hiển thị **chưa xác minh** không bao giờ vào header của thư xác minh (*chốt 2026-10-17, T528 — QA S5 M7*: tên như `Bank <a@evil.com> https://x` biến thư thành kênh giả mạo người gửi): transport `system` → `From` là người gửi hệ thống (`SMTP_FROM`, cả tên lẫn địa chỉ), transport `smtp` → `From` là địa chỉ danh tính, không tên; không `Reply-To`. Với `system` thư xác minh vì vậy không còn kiểm relay chấp nhận `From` của danh tính — lần gửi automation đầu tiên mới kiểm (lỗi → step `failed` `invalid_sender`/`smtp_rejected` như mọi lần gửi). Chặn ký tự `@ < >`/URL trong `display_name` cần đổi zod + CONTRACTS §23 — để sau (tồn S5-review).
- Token = `<org_id>.<secret>` (secret 32 byte ngẫu nhiên), lưu `sha256`, dùng một lần, hết hạn 24 giờ. Phần `org_id` cho trang công khai gọi repository có `organizationId` như mọi repository khác (quy tắc vàng 5) — **không** thêm bảng vào danh sách `GlobalRepository` (SPEC §5.10).
- `GET /verify-sender?token=…` chỉ hiện trang (tên org, người yêu cầu, địa chỉ) với nút "Xác nhận"; chỉ `POST` mới xác nhận, để bộ quét link (Safe Links, gateway) tự mở `GET` không xác nhận thay người dùng. Trang không cần đăng nhập (người đọc hộp thư HR có thể không có tài khoản). `POST` công khai có rate limit theo IP.
- Mã 6 số do org admin nhập trên trang danh tính; tối đa 5 lần sai, sau đó phải gửi lại. Gửi lại thư xác nhận ≤ 3 lần/giờ/danh tính, ≤ 20 lần/ngày/org.
- Kiểm DNS SPF/DMARC (chỉ cảnh báo, dùng resolver của máy chủ) là P1.

### 3. Chữ ký

- Chữ ký là thuộc tính của **danh tính** (`signature_md`), cộng một chữ ký mặc định của org cho người gửi hệ thống (`organizations.settings.email.default_signature_md`). Không theo user/`run_as`.
- S5: Markdown hẹp (cùng `packages/markdown` của ADR-0032 §3), ≤ 2.000 ký tự, **không placeholder** (không mở ngữ cảnh template thứ hai), **≤ 2 ảnh nhúng CID** (*sửa 2026-10-06*, BACKLOG T534 — trước là "không ảnh"): logo/ảnh do org owner/admin upload thành ảnh chữ ký của org (`![alt](asset:…)`), gửi như phần `inline` + `cid:` (ADR-0032 §3 "Ảnh nhúng CID"); URL ảnh hay `data:` bị từ chối khi lưu. Bảng `meta.email_signatures` dùng chung vẫn là P2.
- Action `send_email` có `include_signature` (mặc định `true`). Chỉ org admin sửa chữ ký. Chữ ký và footer chỉ áp cho thư automation; email hệ thống và email thông báo giữ mẫu cố định.

### 4. Footer và header

- Header luôn bắt buộc (ADR-0032 §3): `Auto-Submitted: auto-generated`, `X-Auto-Response-Suppress: OOF, AutoReply`, `X-Cellhive-Automation: <id>`.
- Footer hiện ba mức, i18n theo locale org, sau chữ ký, ở cả HTML và text:
  - `minimal` (mặc định): "Email được gửi tự động bởi Cellhive của «tên org»." — không tên base/automation;
  - `full`: thêm automation «tên» trong base «tên» và link tới automation (cần đăng nhập, không token);
  - `none`: không footer.
- Chính sách theo thứ tự: env `EMAIL_AUTOMATION_FOOTER` (`required` mặc định — cấm `none` mọi org; `org` — giao cho org) → `organizations.settings.email.footer_policy` (`required` mặc định | `author_choice`) → lựa chọn của automation. `none` chỉ khi được phép **và** thư gửi qua danh tính `verified` chế độ `send_as` (thư mang domain của chính tổ chức). Thư qua người gửi hệ thống hoặc `on_behalf` luôn có footer.
- Lưu trái chính sách → `422 AUTOMATION_INVALID` / `EMAIL_FOOTER_NOT_ALLOWED`. Chính sách siết lại sau khi lưu → worker áp `minimal` lúc chạy (không làm hỏng run), builder cảnh báo.
- Không có link unsubscribe ở S5 (thư giao dịch, không phải marketing). `List-Unsubscribe` một chạm là P2.

### 5. Audit

`email_identity.created|verification_sent|verified|updated|credentials_changed|error|disabled|enabled|deleted` (cùng transaction, ADR-0023): `verified` ghi `via`, không token/mã; `updated` có before/after tên, Reply-To, chữ ký, phạm vi (không secret). Đổi cài đặt email của org là `org.updated`. Mỗi lần gửi không audit (nằm trong run step), trừ gửi thử (`automation.test_email_sent`) và kiểm tra kết nối (`email.test_sent`).

## Phương án đã cân nhắc

- **Chỉ người gửi hệ thống** (như Airtable action gốc): an toàn, nhưng không đáp ứng nhu cầu thư nhân danh HR/IT.
- **Gửi bằng email của người tạo/`run_as`** (như Lark): `run_as` đổi theo người sửa (ADR-0025), lộ địa chỉ cá nhân, và không có hộp thư cá nhân trong Cellhive. Bị loại.
- **`From` tuỳ ý không xác minh**: giả mạo và DMARC thất bại. Bị loại.
- **Chỉ SMTP instance cho danh tính** (bản đầu): không gửi được `From: hr@corp.vn` khi relay instance không ký cho `corp.vn` mà không rơi về `on_behalf`; tổ chức có máy chủ mail riêng (LAN) cần đăng nhập bằng chính hộp thư. Người review đưa SMTP riêng danh tính vào S5.
- **SMTP riêng từng action** (như Teable): secret rải trong định nghĩa automation, người quản lý automation tự nhập credential vượt quyền org admin. Bị loại.
- **Token xác minh tra theo hash toàn instance** (thêm ngoại lệ `GlobalRepository`): mở rộng danh sách bảng toàn cục chỉ cho một trang. Chọn token mang `org_id`.
- **`GET` xác nhận ngay**: bộ quét link tự xác nhận. Bị loại.
- **Footer bắt buộc đầy đủ hoặc tắt tuỳ ý**: đầy đủ lộ tên nội bộ; tắt tuỳ ý trên instance nhiều org làm mất dấu vết nguồn khi dùng SMTP chung. Chọn ba mức + chính sách theo tầng.

## Hệ quả

- S5: migration bảng danh tính (kèm cấu hình SMTP riêng, mật khẩu mã hoá), env `SMTP_ALLOW_PRIVATE_HOSTS`, interface transport nhận cấu hình theo danh tính (T513), API quản trị + trang xác minh công khai, `resolveSender`/`resolveFooter` dùng chung, env `SMTP_ALLOWED_FROM_DOMAINS`, `EMAIL_AUTOMATION_FOOTER`, `organizations.settings.email { footer_policy, default_signature_md, system_sender_enabled }`, mã lỗi `EMAIL_IDENTITY_NOT_USABLE`, `EMAIL_FOOTER_NOT_ALLOWED`, `EMAIL_REPLY_TO_INVALID` và mã chạy `email_identity_unavailable` (CONTRACTS §6, §23).
- ADR-0025 §8 vẫn đúng ở ý chính (không gửi dưới danh nghĩa `run_as`); "SMTP của org" được hiểu là P1, S5 dùng SMTP instance và danh tính đã xác minh.
- Tài liệu self-host hướng dẫn `SMTP_ALLOWED_FROM_DOMAINS` (relay phải ký DKIM cho các domain này) và đổi `EMAIL_AUTOMATION_FOOTER=org` cho instance một org.
