# ADR-0036: API token cá nhân có scope (HTTP + WS), OIDC generic cấp instance, secret HTTP gắn host được phép, cứu dòng giao HTTP

- Trạng thái: Accepted (2026-10-19 — người review đã chốt S6 nhận `docs/reviews/S5c-review.md` §12 #1, #3, #9 một phần; các điểm còn lại do coordinator quyết theo phương án an toàn nhất, ghi ở BACKLOG "Quyết định S6"; viết cùng backlog S6)
- Ngày: 2026-10-19
- Sửa đổi (2026-10-24, T721 — ghi lại quyết định đã chốt khi làm task, không đổi chữ đã Accepted bên dưới; thắng câu tương ứng khi khác nhau):
  - §1 Scope (T720 H1, BACKLOG "Câu hỏi mở S6" #10): giá trị record không đi qua scope automation — xem trước/gửi thử email và gửi thử HTTP có `record_id` qua token cần thêm `records:read`; chi tiết run qua token không có `records:read` ẩn mọi giá trị record của bước. Automation tạo/sửa qua token vẫn chạy `run_as` = chủ token (C§26.2).
  - §1 Giới hạn (T704, T720 M1, "Câu hỏi mở S6" #11): Bearer sai bị giới hạn 300 lần/phút/IP **trước** mọi truy vấn DB; token đã xác thực thành công trong 10 phút (khoá Valkey `ob:bearer_ok:<sha256>`) đi qua giới hạn này và vẫn được kiểm đủ (C§26.1).
  - §2 (T706, "Câu hỏi mở S6" #4): kết nối token có bộ đếm riêng 10/token/instance (không tính vào 10/user của nhánh cookie), vượt → `429` + `Retry-After: 30`; kiểm lại hết hạn bằng timer riêng 60 s. Header được đọc trong `RealtimeGateway` qua cùng resolver của `common/auth` (`bearerTokenOf` + `ApiTokenAuthService`).
  - §3 Liên kết thủ công (T708 review, "Câu hỏi mở S6" #3 (g)): bắt đầu bằng `POST /api/v1/me/identities/:provider/start` (session + CSRF) trả `{ authorization_url }`, không `GET`; chế độ link gửi `max_age=0` và đòi `auth_time` ≤ 10 phút; gỡ là `DELETE /api/v1/me/identities/:userIdentityId` (C§27.3).
  - §5 Worker chết (T702, BACKLOG "Tồn đọng S6"): graphile-worker 0.18 khoá job theo id của **worker pool**, nên id là `workerPool.id = ob-<hostname>-<pid>-<8 base62>` đặt trong sự kiện `pool:create`; lúc khởi động chỉ mở khoá id cùng hostname mà advisory lock sống còn (`workerLivenessKey`) đang trống — tiến trình còn sống không bị mở khoá. Kết nối giữ lock phải đi thẳng tới PostgreSQL (advisory lock phiên không qua được PgBouncer chế độ transaction; QA S6 L7).
  - §5 / "Phương án đã cân nhắc" (T702): cron cứu dòng giao đọc **view công khai** `graphile_worker.jobs` (`NOT EXISTS` theo `key`) để bỏ qua dòng còn job chờ — không đọc bảng `_private` của thư viện; câu "bỏ quét `graphile_worker`" hiểu là không quét bảng nội bộ để tìm job thiếu (C§25.5). Nâng graphile-worker phải chạy lại `restart.int` và `http-deliveries-rescue.int`.
- Sửa: SPEC §5.10 (`api_tokens` thêm cột, `user_identities` thêm cột, `secrets` thêm cột), §13.1 (auth Bearer, định dạng token, scope, rate limit theo token, route OIDC đổi sang `GET`), §14.1 (tra cứu vượt tenant mới `findApiTokenByHash`, `listStuckHttpDeliveries`; thứ tự giải quyết bước 6), §14.2 (OIDC), §14.4 (nguồn API token trong lịch sử/audit), §15 (WS bằng header `Authorization` thay "token ở message đầu"), §20 (env `OIDC_*`), §22 (dòng S6); CONTRACTS §5 (P53–P64), §6, §7, §8, §11.1, §11.4, §12.0, §24, §26–§27 (mới). Làm rõ ADR-10 (OIDC generic) và ADR-35 §4, §8 — không sửa nội dung đã Accepted của chúng. Nguồn: `docs/reviews/S6-research.md`.

## Bối cảnh

S§13.1 mô tả token (`cht_…`, SHA-256, scope `records:read|write`, `schema:read|write`, `automations:write`, giới hạn base) và route OIDC `POST /auth/oidc/:provider/start|callback`; S§15 và C§7 để "token ở message đầu" cho WS tới S6; ADR-10 chọn "OIDC generic" mà không nói cấu hình ở đâu, liên kết tài khoản thế nào. Code `main` `f3dd942f` chưa có bảng token, guard Bearer hay client OIDC (`meta.user_identities` có từ `0001`). Ba câu hỏi thiết kế không có câu trả lời trong tài liệu đã Accepted: (1) ghi qua token mang actor nào; (2) ai được tin để cấu hình IdP khi `users` là bảng toàn cục và một người thuộc nhiều org; (3) liên kết đăng nhập OIDC với tài khoản có sẵn — tự liên kết theo email là nguồn chiếm tài khoản đã biết (nOAuth, các GHSA trong nghiên cứu §2.3).

Hồi cứu S5c để lại hai rủi ro được kéo vào S6: secret `http_header`/`webhook_signing` "dùng được = đọc được" với người dựng automation trỏ URL về máy mình (QA S5c M4), và dòng giao HTTP kẹt khi job `http.deliver` mất hẳn hoặc worker chết giữ khoá job 4 giờ (T15/I7).

Quy mô (nghiên cứu §3.1): small–medium; không thêm hạ tầng (quy tắc vàng #7).

## Quyết định

### 1. API token

- **Định dạng**: `cht_` + 30 ký tự base62 (CSPRNG) + 6 ký tự base62 của CRC32 trên 30 ký tự đó (kiểu GitHub). Sai định dạng/checksum, không tồn tại → `401 UNAUTHENTICATED` không chạm DB (checksum) / sau một lần tra; đã thu hồi → `401 TOKEN_REVOKED`, hết hạn → `401 TOKEN_EXPIRED` (hai mã có sẵn ở C§6; người cầm token là chủ nên được biết lý do); mọi `401` của Bearer kèm `WWW-Authenticate: Bearer error="invalid_token"`. `token_prefix` = 8 ký tự đầu sau `cht_` (hiển thị `cht_AbCdEfGh…`). Tiền tố đã chốt là `cht_` (sửa 2026-10-24, ADR-37 thay câu cũ "tiền tố đổi theo tên dự án phải nhận cả tiền tố cũ": chưa từng cấp token nên không nhận tiền tố nào khác).
- **Lưu**: `token_hash` = SHA-256 (như session, share link, webhook vào); không pepper (đánh đổi ở nghiên cứu §3.4). Hiện một lần trong response tạo. Tra cứu từ request qua `findApiTokenByHash` trong `db/cross-tenant-lookups.ts` (chỉ trả org id + token id); mọi kiểm tra khác trong scope org.
- **Sở hữu**: token thuộc (user, org) — FK ghép tới `org_members` `ON DELETE CASCADE` (rời org = mất token; audit giữ id). Hợp lệ khi: chưa thu hồi, chưa hết hạn, `organizations.settings.api_tokens.enabled` (mặc định `true`), user `active` và còn là member.
- **Quyền hiệu lực** = quyền **hiện tại** của user (resolve mỗi request như session, S§14.1) ∩ scope ∩ `base_ids` (nếu có) ∩ org của token. Tài nguyên ngoài base/org của token → `404` (như không tồn tại); trong phạm vi nhưng thiếu scope → `403 INSUFFICIENT_SCOPE` (`params.required` = scope cần).
- **Scope** (đóng, C§26.2): `records:read`, `records:write`, `schema:read`, `schema:write`, `automations:read`, `automations:write`. Thêm `automations:read` so với S§13.1 để xem run/lịch sử chạy không cần quyền ghi. `*:write` không ngầm có `*:read`. Mỗi route trong OpenAPI có đúng một mục ở bảng route → scope (C§26.3) hoặc nhãn **chỉ session** (quản lý token, role, thành viên, group, workspace, secret, allowlist, share link, audit, cài đặt org, setup, OIDC, `/me/identities`); test khoá: route mới thiếu mục → test đỏ.
- **Bearer thắng cookie**: request có `Authorization: Bearer` chỉ xác thực bằng token (sai → `401`, không rơi về cookie), không kiểm CSRF (trình duyệt không tự gửi header này; CORS chỉ origin cấu hình).
- **Ghi**: actor = **user sở hữu** (`actor_type = user`), `via = { "api_token_id": "tok_…" }` trên audit, event, lịch sử record (contract `via` có từ C§11.1); `updated_by` = user. Lịch sử/audit render `via.api_token_name` (tên hiện tại; token đã xoá → `null`) chỉ cho org owner/admin và chính chủ token, người khác thấy "API token" không tên. Không dùng `actor_type = api_token` (giữ trong CHECK, không ghi mới).
- **Giới hạn**: rate limit khoá `tok_…` (60 req/s, 20 req/s/base — S§13.1); `last_used_at` ghi bằng `UPDATE … WHERE last_used_at IS NULL OR last_used_at < now() - interval '5 minutes'`; ≤ 50 token chưa thu hồi mỗi (user, org); hết hạn mặc định UI 90 ngày, `expires_at` NULL chỉ khi org không đặt `settings.api_tokens.max_lifetime_days`; token thu hồi/hết hạn quá 90 ngày bị cron `maintenance.cleanup` xoá.
- **Tạo/thu hồi chỉ bằng session**; org owner/admin liệt kê (siêu dữ liệu) và thu hồi mọi token của org; thu hồi/tắt chính sách → envelope realtime `api_token.revoked` (bus Valkey có sẵn) để đóng WS.

### 2. WS bằng token

Bắt tay `/ws` có header `Authorization: Bearer cht_…` → xác thực như §1, **không** kiểm `Origin` (trình duyệt không đặt được header này cho WebSocket nên không có cross-site WebSocket hijacking), giới hạn 10 kết nối/token/instance; subscribe `table:`/`base:` cần `records:read` (kiểm như `records/query`, kể cả `base_ids`); `user:` → `error` `NOT_FOUND` với token. Thu hồi, hết hạn (kiểm mỗi lần kiểm lại quyền và mỗi 60 s), user rời org → đóng `4401`. Thay "token ở message đầu" của S§15/C§7: không cần trạng thái "chưa xác thực" trong giao thức, token không vào access log như query string.

### 3. OIDC

- **Cấu hình cấp instance qua env** (S§20): `OIDC_PROVIDERS` (danh sách slug `[a-z0-9-]{1,32}`), mỗi slug `OIDC_<SLUG>_ISSUER` (discovery `/.well-known/openid-configuration`), `_CLIENT_ID`, `_CLIENT_SECRET`, `_NAME`, `_SCOPES` (mặc định `openid email profile`), `_ALLOW_SIGNUP` (`false`), `_ALLOWED_DOMAINS`, `_LINK_BY_EMAIL` (`false`), `_AUTO_JOIN_ORG` (slug org, trống). Không cấu hình theo org: chỉ người vận hành tin được IdP; IdP theo org cho phép org admin của instance chia sẻ chiếm tài khoản người thuộc nhiều org.
- **Luồng**: authorization code + PKCE S256 + `state` + `nonce` (RFC 9700 §2.1); `GET /api/v1/auth/oidc/:provider/start?next=` → cookie `ob_oidc` (AES-256-GCM, khoá HKDF từ `SESSION_SECRET` `info = oidc-state:v1`, 10 phút, `HttpOnly; SameSite=Lax; Path=/api/v1/auth/oidc/`) → `302` IdP; `GET …/callback` → kiểm `state` rồi xoá cookie (một lần) → đổi code → kiểm ID token (`iss` đúng issuer, `aud`, `exp`, `nonce`, chữ ký JWKS) → session `ob_session` như đăng nhập mật khẩu, `302` tới `next` (chỉ path nội bộ). Lỗi → `302 /login?error=<CODE>`. Thay `POST` của S§13.1 (IdP chuyển hướng bằng `GET`).
- **Thư viện**: `openid-client` v6 (MIT, panva, OpenID Certified; kéo `oauth4webapi` + `jose`, MIT) — dependency mới duy nhất của S6, lý do ghi trong báo cáo task. Gọi IdP là ngoại lệ có tên của "một cửa mạng ra" (như `TelegramClient`): URL do người vận hành cấu hình qua env, có thể là địa chỉ nội bộ (Keycloak trong LAN); timeout 10 s; discovery + JWKS cache 1 giờ, nạp lại khi gặp `kid` lạ.
- **Định danh** = `(provider, sub)` (OIDC Core §5.7). Thứ tự ở callback: (a) có identity → user đó (user không `active` → từ chối như đăng nhập mật khẩu, `/login?error=UNAUTHENTICATED`); (b) không có, có user cùng email: chỉ liên kết khi `_LINK_BY_EMAIL=true` **và** `email_verified === true`, không thì `OIDC_ACCOUNT_EXISTS` (đăng nhập bằng mật khẩu rồi liên kết trong hồ sơ); (c) không có user: tạo khi `_ALLOW_SIGNUP=true`, `email_verified === true` và domain email trong `_ALLOWED_DOMAINS` (nếu đặt), không thì `OIDC_SIGNUP_DISABLED` / `OIDC_DOMAIN_NOT_ALLOWED`; user mới không mật khẩu, vào org chỉ qua lời mời hoặc `_AUTO_JOIN_ORG` (vai trò `member`).
- **Liên kết thủ công**: `GET /api/v1/me/identities/:provider/start` (session, chế độ `link` trong cookie state) → callback gắn `(provider, sub)` vào user đang đăng nhập (`IDENTITY_IN_USE` nếu đã thuộc user khác); gỡ: `DELETE /api/v1/me/identities/:id` (không gỡ được phương thức đăng nhập cuối — `LAST_LOGIN_METHOD`).
- **Ngoài phạm vi**: map group/claim → role, bắt buộc SSO / tắt đăng nhập mật khẩu, RP-initiated logout, SAML, IdP theo org (P1/P2 — Quyết định S6).

### 4. Secret HTTP gắn host được phép (QA S5c M4)

- `meta.secrets.allowed_hosts text[]` (pattern như allowlist C§25.4 — host chính xác hoặc `*.hậu_tố` ≥ 2 nhãn, `:cổng` tuỳ chọn, không IP/CIDR, ≤ 20 mục) — **Sửa đổi (2026-10-25, sửa lỗi review)**: mục không cổng chỉ cho `https` (80/443); URL `http://` thường chỉ khớp mục ghi rõ cổng của nó (mục loopback/dev `localhost:5678`, service Docker `n8n:5678` vẫn dùng được), không thì `not_listed` — secret không bao giờ đi dạng rõ chỉ vì host khớp mục không cổng, chỉ với kind `http_header`/`webhook_signing` (CHECK: kind khác → rỗng). Tạo secret HTTP mới bắt buộc ≥ 1 mục (`SECRET_HOSTS_REQUIRED`).
- Kiểm **lúc lưu** automation/gửi thử khi URL là literal (`422 AUTOMATION_INVALID` / `SECRET_HOST_NOT_ALLOWED`) **và lúc gửi** trong `HttpDeliverer.prepare` trên host đã chuẩn hoá của URL sau render (không follow redirect nên đó là host cuối) → bước `failed` `secret_host_not_allowed` trước khi giải mã secret và trước mọi kết nối. Áp cho `auth` (`http_header`) và `signing_secret_id` (`webhook_signing`) của `http_request`, `run_n8n_workflow`, gửi thử. Không mở địa chỉ private (vẫn là việc của `meta.http_allowlist`).
- **Secret cũ** (có trước migration, `allowed_hosts` rỗng): migration đặt `legacy_hosts_until = now() + 30 ngày`; tới hạn đó vẫn gửi được (UI cảnh báo ở danh sách secret và editor bước), sau đó `secret_host_not_allowed` với `params.reason = legacy_expired`. Đặt danh sách → xoá `legacy_hosts_until`.

### 5. Cứu dòng giao HTTP + mở khoá job của worker chết (T15/I7)

- Cron `http.deliveries_rescue` mỗi phút: tra cứu vượt tenant mới `listStuckHttpDeliveries(now, limit 500)` — dòng `pending` có `next_attempt_at < now − 60 s` hoặc `sending` có `lease_until < now − 30 s` (dùng index `http_deliveries_due_idx`, chỉ trả org id + id) → trong scope org thêm lại job `http.deliver` với `job_key = http:<id>` (`job_key_mode = preserve_run_at`); lease + `attempts` của ADR-35 §4 giữ idempotent. Metric `http_deliveries_rescued_total`.
- Worker đặt `workerId` = `ob-<HOSTNAME>-<ngẫu nhiên>`; lúc khởi động gọi `forceUnlockWorkers` của graphile-worker cho các `locked_by` bắt đầu bằng `ob-<HOSTNAME>-` khác chính mình (tiến trình trước trên cùng container đã chết). Nhiều replica khác hostname không mở khoá của nhau (giữ mốc 4 giờ của graphile — ghi tài liệu self-host).

## Phương án đã cân nhắc

- **Token HMAC có pepper** (nghiên cứu §2 khuyến nghị): bỏ — entropy ≥ 178 bit, pepper buộc token vào `APP_MASTER_KEY`, khác cách lưu session/share link/hook.
- **Actor `api_token`** riêng: bỏ — tách người chịu trách nhiệm khỏi thao tác, lọc audit theo người bỏ sót thao tác qua token.
- **WS token ở message đầu / query string**: bỏ — cần trạng thái chưa xác thực, hoặc token vào access log/Referer.
- **OIDC theo org trong DB**: bỏ cho S6 — xem §3; khi cần phải có xác minh domain (ADR mới).
- **Tự liên kết theo email** (Teable): bỏ làm mặc định — chiếm tài khoản qua IdP cho đặt email tuỳ ý.
- **State OIDC trong DB/Valkey**: bỏ — cookie mã hoá một lần là đủ, không thêm bảng/khoá.
- **Secret HTTP chỉ base admin chọn được** (QA S5c M4 phương án 3): bỏ — vẫn lộ cho base admin trỏ URL về máy mình; gắn host chặn cả hai.
- **Cứu dòng giao bằng cách quét `graphile_worker` tìm job thiếu**: bỏ — phụ thuộc bảng nội bộ của thư viện; thêm lại job theo `job_key` là thao tác công khai, idempotent.

## Hệ quả

- Thêm một dependency (`openid-client`), không thêm dịch vụ; ba migration forward-only (`api_tokens`, cột `user_identities`, cột `secrets`) + một migration index audit (BACKLOG S6).
- Danh sách tra cứu vượt tenant S§14.1 thêm `findApiTokenByHash`, `listStuckHttpDeliveries`, nhánh xoá token cũ trong `purgeExpiredOperationalRows`.
- Mọi route mới từ nay phải khai báo scope hoặc "chỉ session" (test khoá).
- Tích hợp đang dùng secret HTTP cũ phải đặt danh sách host trong 30 ngày sau nâng cấp (Upgrade notes S9).
- Người dùng chỉ OIDC không có mật khẩu: đặt lại mật khẩu vẫn `422 NO_PASSWORD`; owner duy nhất mất IdP dùng CLI `cellhive user reset-password` để đặt mật khẩu (break-glass).
