# ADR-0037: Đổi tên sản phẩm OpenBase thành Cellhive; định danh nội bộ trung lập thương hiệu

- Trạng thái: Accepted (2026-10-24 — coordinator chốt trước bản phát hành đầu tiên)
- Ngày: 2026-10-24
- Sửa đổi (2026-10-25, backlog S7 — người review xác nhận "Câu hỏi mở S6" #14 (d); thắng câu tương ứng bên dưới khi khác nhau):
  - §1: đuôi tệp gói base (ADR-24) đổi `.obbase` → **`.chbase`** (người dùng thấy trong tên tệp tải về, như tiền tố token). **Không** nhận `.obbase` khi nhập — chưa có code tạo gói (S9), chưa từng có tệp nào được tạo; cùng lý do không nhận `obt_` (§2). `format` trong manifest (`cellhive-base`) không đổi. Sửa tài liệu (SPEC §2, §17.1, §22; CONTRACTS §6, §12.2; ADR-24; ADR-29) ở BACKLOG T804.
- Sửa: tên sản phẩm trong mọi tài liệu (README, SPEC, CONTRACTS, FRONTEND, BACKLOG, ADR, `docs/reviews`, `docs/integrations`, CONTRIBUTING…); SPEC §4 (tên monorepo), §5.10 (GUC của `meta.audit_redact`, bảng migrator), §14.1–§14.2 (CLI), §20 (env, compose, image); CONTRACTS §6 (`type` của problem+json), §9 (seed demo), §10 (header `X-Cellhive-Causation`), §23.1 (header `X-Cellhive-Automation`), §26.1 (tiền tố API token `cht_`); ADR-36 §1 (câu "tiền tố đổi phải nhận cả tiền tố cũ" bị thay); FRONTEND (khoá `localStorage`). Ngoại lệ một lần cho quy tắc vàng #9 (AGENTS.md).

## Bối cảnh

"OpenBase" là tên tạm (README ghi "Working name", SPEC ghi "tên tạm"); ADR-27 và ADR-35 để tên header causation "đổi theo tên dự án khi chốt". Tên chính thức là **Cellhive**. Repo vừa công khai trên GitHub (`Gum97/OpenBase`, sẽ chuyển sang org `cellhive`); chưa có bản phát hành, chưa ai cài đặt, không có dữ liệu production. Đây là thời điểm rẻ nhất để đổi tên: sau bản phát hành đầu tiên, mọi định danh nằm trong dữ liệu đã lưu (GUC trong trigger, nhãn HKDF của khoá mã hoá, tên bảng migrator) sẽ chỉ đổi được bằng migration dữ liệu.

Một số định danh nội bộ chứa tên thương hiệu dù người dùng không bao giờ thấy: GUC `openbase.audit_redact` (trigger append-only của `meta.audit_logs`, migration `0001`), `info` HKDF `openbase:<purpose>` của mọi khoá dẫn xuất từ `APP_MASTER_KEY`/`SESSION_SECRET` (ciphertext trong `meta.secrets`, `meta.user_channels`, `meta.incoming_webhooks`, `meta.http_deliveries`, `meta.telegram_webhooks`, phản hồi idempotent…), bảng `openbase_migration`/`openbase_migration_lock`. Nếu chỉ thay token thương hiệu, lần đổi tên sau (hoặc một bản fork) lại phải chạm dữ liệu đã lưu.

## Quyết định

### 1. Tên mới (chỉ token thương hiệu đổi, phần còn lại của định danh giữ nguyên)

| Loại | Cũ | Mới |
|---|---|---|
| Tên sản phẩm (không dịch, en và vi) | OpenBase | Cellhive |
| npm scope | `@openbase/*` | `@cellhive/*` |
| CLI | `openbase` | `cellhive` (`pnpm cellhive …`, `/usr/local/bin/cellhive` trong image) |
| Env | `OPENBASE_VERSION` | `CELLHIVE_VERSION` |
| Header | `X-OpenBase-Causation`, `X-OpenBase-Automation` | `X-Cellhive-Causation`, `X-Cellhive-Automation` |
| `type` problem+json | `https://openbase.dev/errors/<CODE>` | `https://cellhive.io/errors/<CODE>` |
| URL tài liệu/site | `openbase.dev` | `cellhive.io` |
| Repo | `Gum97/OpenBase` | `https://github.com/cellhive/cellhive` (coordinator chuyển repo) |
| Compose project | `openbase`, `openbase-dev` | `cellhive`, `cellhive-dev` |
| Postgres user/db dev + compose, bucket S3 | `openbase` | `cellhive` |
| Image | `ghcr.io/openbase/openbase-api`, `…/openbase-web` | `ghcr.io/cellhive/cellhive-api`, `…/cellhive-web` |
| `application_name` | `openbase-worker`, `openbase-cli`… | `cellhive-worker`, `cellhive-cli`… |
| `User-Agent` HTTP ra | `OpenBase/0.1` | `Cellhive/0.1` |
| `localStorage`/BroadcastChannel | `openbase.*` | `cellhive.*` |
| Miền test, user demo | `openbase.test`, `@demo.openbase.local` | `cellhive.test`, `@demo.cellhive.local` |
| Mật khẩu demo/bench | `OpenBase-demo-2026`, `OpenBase-bench-2026` | `Cellhive-demo-2026`, `Cellhive-bench-2026` |
| Content-ID ảnh nhúng | `att_…@openbase` | `att_…@cellhive` |
| Định dạng gói base (ADR-24) | `openbase-base` | `cellhive-base` |
| Tiền tố API token (ADR-36 §1) | `obt_` | `cht_` (không nhận tiền tố cũ — §2) |

README và README.vi bỏ ghi chú "Working name"/"Tên tạm"; SPEC bỏ "(tên tạm)".

### 2. Định danh nội bộ trung lập thương hiệu

Định danh nằm trong dữ liệu đã lưu hoặc trong phép mã hoá không mang tên sản phẩm:

| Định danh | Cũ | Mới |
|---|---|---|
| GUC của `meta.audit_redact` | `openbase.audit_redact` | `app.audit_redact` |
| HKDF `info` (khoá từ `APP_MASTER_KEY`, `secret-box.ts`) | `openbase:<purpose>` | `<purpose>:v1` — `idempotency-response:v1`, `email-identity-smtp:v1`, `email-identity-code:v1`, `org-secret:v1`, `user-channel:v1`, `user-channel-lookup:v1`, `incoming-webhook:v1`, `incoming-webhook-signing:v1`, `http-delivery:v1`, `telegram-webhook:v1` |
| HKDF `info` (khoá từ `SESSION_SECRET`, `deriveKey`) | `openbase:<purpose>` | `csrf:v1`, `oidc-state:v1`, `form-submit-token:v1`, `share-unlock:v1` |
| Nhãn HMAC URL ký của storage local | `openbase:storage-local-url:v1` | `storage-local-url:v1` |
| Bảng migrator (schema `public`) | `openbase_migration`, `openbase_migration_lock` | `app_migration`, `app_migration_lock` |
| Khoá metadata Nest, cờ route Fastify | `openbase:requireBase`, `openbase:publicAccess`, `openbaseRawUpload` | `app:requireBase`, `app:publicAccess`, `rawUpload` |
| Performance mark (web, test perf) | `openbase:grid:first-data`, `openbase:tree:branch-rows`, `openbase:kanban:first-cards` | `app:grid:…`, `app:tree:…`, `app:kanban:…` |
| Biến `map`/`set` của nginx | `$openbase_*` | `$app_*` |

Mỗi nhãn HKDF vẫn duy nhất trong cùng khoá gốc và có hậu tố phiên bản; `automation-causation-v1` (ADR-27) vốn đã trung lập nên giữ nguyên. Khoá advisory lock (`automation-org:`, `form-submissions:`, `hashtext(kind || ':' || org)`…) vốn không chứa tên thương hiệu.

**Giữ nguyên** (viết tắt `ob`, không đánh vần tên thương hiệu, đổi chỉ tốn công mà không bớt rủi ro): tiền tố khoá Valkey `ob:` (rate limit, nhịp gửi Telegram…), cookie `ob_session`, `ob_csrf`, `ob_oidc`, `ob_share_<shl_…>`, AAD `ob_oidc:v1` của cookie OIDC, tên kind ô/icon của grid `ob-*`, lớp CSS `ob-grid`.

**Tiền tố API token đổi `obt_` → `cht_`** (coordinator chốt 2026-10-24): token là thứ người dùng thấy, dán vào script và công cụ quét secret nhận diện theo tiền tố, nên nó theo tên sản phẩm. Định dạng giữ nguyên: `cht_` + 30 base62 + 6 base62 của CRC32 trên 30 ký tự ngẫu nhiên (40 ký tự, `token_prefix` 8 ký tự sau `cht_`). **Không** nhận `obt_`: chưa từng cấp token nào, nên câu "đổi tiền tố phải nhận cả tiền tố cũ" của ADR-36 §1 được thay bằng quyết định này. Đây là chỗ duy nhất trong repo còn ghi tiền tố cũ.

### 3. Ngoại lệ một lần cho quy tắc vàng #9 (migration chỉ tiến)

Sửa tại chỗ các migration đã merge chứa tên thương hiệu: `0001_initial` (GUC trong trigger và `meta.audit_redact`), `0036_secrets`, `0040_user_channels`, `0043_incoming_webhooks`, `0044_http_deliveries`, `0046_telegram_webhooks` (chú thích nhãn HKDF), `0049_api_tokens` (chú thích tiền tố token); sinh lại `packages/server-core/src/db/migrations.lock.json` bằng `scripts/lock-migrations.mjs` (xoá danh sách rồi khoá lại toàn bộ; chỉ bảy checksum trên đổi). Không thêm migration mới. Lý do: chưa có bản phát hành, chưa có bản cài đặt nào, không có dữ liệu cần chuyển; một migration "đổi tên GUC" sẽ để lại vĩnh viễn trong lịch sử định danh cũ mà không ai cần. Ngoại lệ chỉ áp dụng cho lần đổi tên này; từ bản phát hành đầu tiên quy tắc #9 áp dụng nguyên vẹn.

## Phương án đã cân nhắc

- **Chỉ thay token thương hiệu ở mọi nơi** (`cellhive.audit_redact`, `cellhive:<purpose>`, `cellhive_migration`): đơn giản hơn, nhưng lần đổi tên sau (hoặc fork) lại phải viết migration dữ liệu và mã hoá lại mọi secret. Bị loại.
- **Thêm migration mới đổi GUC/bảng migrator và mã hoá lại secret**: đúng quy tắc #9 nhưng vô nghĩa khi chưa có bản cài đặt; để lại code chuyển đổi và nhãn cũ mãi mãi. Bị loại.
- **Đổi cả các viết tắt `ob` nội bộ** (cookie, Valkey, kind/CSS): không có lý do kỹ thuật, `ob` không đánh vần tên và người dùng không dán chúng đi đâu; giữ để phạm vi thay đổi nhỏ. Riêng tiền tố API token thì đổi (§2).
- **Đổi tiền tố token nhưng vẫn nhận `obt_`** (theo câu cũ của ADR-36 §1): không cần vì chưa có token nào được cấp; nhận hai tiền tố chỉ thêm nhánh code và làm yếu nhận diện của công cụ quét secret. Bị loại.

## Hệ quả

- Định dạng contract đổi giá trị, không đổi cấu trúc (quy tắc vàng #8): zod, `CONTRACTS.md` (v1.95) và `openapi.json` (sinh lại bằng `pnpm gen:openapi`) cập nhật cùng nhánh. Client tự viết kiểm `type` problem+json hoặc header `X-OpenBase-*` phải đổi theo — chưa có client ngoài nào.
- Ciphertext, cookie đã ký, URL storage local đã ký và phiên bản migration cũ không đọc được với nhãn mới. Mọi DB dev/test phải tạo lại:

  ```bash
  docker compose -f docker-compose.dev.yml down -v   # project cũ: COMPOSE_PROJECT_NAME=openbase-dev
  pnpm dev:infra
  pnpm db:migrate
  pnpm seed:demo
  ```

  Project compose đổi tên (`cellhive-dev`) nên container/volume cũ `openbase-dev_*` không bị dùng lại; xoá chúng bằng `docker compose -p openbase-dev -f docker-compose.dev.yml --profile init down -v` khi không cần nữa. `.env` cục bộ có `DATABASE_URL=postgres://openbase:openbase@…/openbase`, `S3_BUCKET=openbase` phải sửa theo `.env.example`. Testcontainers tự tạo DB mới nên không cần làm gì.
- Trình duyệt mất tuỳ chọn cục bộ cũ (`openbase.*`: theme, ngôn ngữ, layout cột, view cuối, bản nháp view) — chấp nhận được trước bản phát hành.
- Artifact thiết kế bên ngoài repo (canvas "OpenBase UI") được tài liệu gọi là "Cellhive UI"; đổi tiêu đề artifact là việc của coordinator. Thư mục checkout cục bộ, repo GitHub, org `ghcr.io` và tên miền `cellhive.io` nằm ngoài repo và do coordinator xử lý.
- Từ ADR này, chỉ ADR-37 và mục CHANGELOG của lần đổi tên còn nhắc "OpenBase".
