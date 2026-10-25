# Cellhive — Build Specification for AI Coding Agents

Version: 1.57 (T816 — §8 `color_rules` của view grid: tô màu dòng/ô theo điều kiện, đánh giá ở server theo quyền người xem, `record.meta.color`; chi tiết C§1.4, §7, §15, §16A). 1.56 (T809 — §15A.3 route dashboard qua link `/dashboard`, `/widgets/{id}/data|options|export`, nhúng qua `GET /shares/{token}/page` + `X-Accel-Redirect` (CSP `frame-ancestors` theo link), `refresh_seconds` 30..3600). 1.55 (T810 — §15A.1 key `allow_export` (export qua link view, cần `download` hiện tại của người tạo), §15A.3 route `/shares/{token}/export`). 1.54 (T806 — §10.3 dữ liệu widget qua `RecordQueryService.widgetData`, không có service aggregate riêng; §13.1 route `POST /api/v1/widgets/:id/data`). 1.53 (T805 — ADR-38: §5.10 `meta.dashboards` bỏ `layout`, thêm `description`, `version`, `created_by`, `deleted_by`; `meta.dashboard_widgets` thêm `title`, `layout`; §10 layout trên widget, thùng rác, `version`; §13.1 route dashboard/widget). 1.52 (T804 — ADR-37: đuôi gói base `.chbase` ở §2, §17.1, §22 S11). 1.51 (backlog S7: §22 dòng S7 viết lại theo "Quyết định S7" — phạm vi, ngoài phạm vi, mốc). 1.50 (T721 — hồi cứu S6: §13.1 tiền tố token đã chốt `cht_`, giới hạn Bearer sai theo IP + `ob:bearer_ok`, header WS đọc trong `RealtimeGateway` qua resolver của `common/auth`, thêm route `/me/identities`, quyền hiệu lực/principal, export audit base, `/redact` chỉ route org; §5.10 index 0052 của `audit_logs`; §19 metric `oidc_callbacks_total`, `http_secret_host_blocked_total`, kết nối liveness của worker không qua PgBouncer chế độ transaction; §22 dòng S7 nhận P21 + export qua share link). Trước đó 1.49 (ADR-37: đổi tên sản phẩm thành Cellhive — CLI `cellhive`, env `CELLHIVE_VERSION`, compose project `cellhive`, Postgres user/db và bucket S3 `cellhive`, image `ghcr.io/cellhive/cellhive-api`, header `X-Cellhive-Causation`/`X-Cellhive-Automation`, tiền tố API token `cht_` §13.1; định danh nội bộ trung lập thương hiệu: GUC `app.audit_redact`, HKDF `info` = `<purpose>:v1`, bảng migrator `app_migration`/`app_migration_lock`; migration cũ sửa tại chỗ một lần). Trước đó 1.48 (T705: §14.4 nguồn API token — actor = user + `via.api_token_id`, tên token chỉ cho org owner/admin và chủ token. Trước đó 1.47 — T704: §13.1 xác thực Bearer — `AuthGuard` + `ScopeGuard`, bảng route → scope theo `operationId`, `401` + `WWW-Authenticate`, rate limit/`Idempotency-Key` theo `tok_…`; §14.1 bước 6 — quyền hiện tại ∩ scope ∩ `base_ids` ∩ org, ngoài phạm vi → `404`). Trước đó: 1.46 (backlog S6: ADR-36 — API token cá nhân `cht_` + CRC32 lưu SHA-256, scope đóng + `automations:read`, mọi route khai báo scope hoặc "chỉ session", ghi qua token mang actor = user + `via.api_token_id`, Bearer thắng cookie; WS bằng header `Authorization` lúc bắt tay; OIDC generic cấp instance qua env `OIDC_*`, route `GET start|callback`, PKCE + `state` + `nonce`, không tự liên kết theo email mặc định; secret HTTP gắn host được phép; cứu dòng giao HTTP + `forceUnlockWorkers`; §13.1, §14.2, §15, §22 dòng S6 — chi tiết do task S6 ghi). Trước đó: 1.45 (T617 — hồi cứu S5c: §5.10 index `automation_runs_trigger_event_idx` (0048) và index `(received_at)` của `incoming_webhook_requests`; §11.5 gửi thử bước `run_n8n_workflow` + mẫu đã nghe cho trigger `webhook.received`; §19 worker chưa có `/metrics`, logger bỏ dữ liệu dòng của lỗi PostgreSQL; §20 `PUBLIC_URL` (URL hook, host token causation, chế độ webhook Telegram), `WEBHOOK_MAX_RATE_PER_SEC` (1–1.000, burst 4×)). Trước đó: 1.44 (T616 — QA S5c: §20 `WORKER_CONCURRENCY` — lời gọi HTTP ra dùng tối đa `max(1, WORKER_CONCURRENCY − 1)` slot, tăng khi gọi đích chậm (ADR-35 §4 Sửa đổi); §13.3 payload n8n có `event.entity_id`; §14.3 phân loại IPv6 thêm site-local, Teredo, `3fff::/20`, IPv4-translated, NAT64 `64:ff9b:1::/48`). Trước đó: 1.43 (T616: §11.6, §13.3 — token `X-Cellhive-Causation` gắn chính instance (host `PUBLIC_URL` + `/api/v1/hooks`) thay cho host + path đích, `/hooks/:token` kiểm host như cũ và path theo tiền tố hook, nên n8n/hệ ngoài chuyển tiếp header vẫn nối chuỗi loop guard — Sửa đổi ADR-27 §5, ADR-35 §5; trỏ C§10). Trước đó: 1.42 (T607: action `run_n8n_workflow` §11.5 — preset của `http_request`: `POST` payload chuẩn §13.3 dựng bằng `RecordQueryService` với quyền `run_as` lúc chạy (chỉ field đọc được, record liên kết không đọc được `title = null`, `record: null` khi không có/không đọc được record, `changes` của field gửi đi), secret `webhook_signing` bắt buộc, payload > 1 MiB → `http_request_too_large`, giao qua outbox như `http_request` — trỏ C§21 "run_n8n_workflow"; §13.3 trỏ ADR-35 và C§21). Trước đó: 1.41 (T606: action `http_request` §11.5 — render bằng `run_as` lúc chạy (giá trị trong URL mã hoá phần tử URL, body JSON escape chuỗi JSON, header một dòng ASCII), giao qua outbox §11.7 (không gọi mạng trong bước), header auth từ secret `http_header`, chữ ký Standard Webhooks từ secret `webhook_signing`, `fail_on_http_error`, gửi thử qua outbox trỏ C§25.5; `meta.secrets` §5.10 thêm kind `http_header`/`webhook_signing` + cột `previous_ciphertext`/`previous_expires_at` (giá trị cũ ký thêm 24 h) — migration 0047). Trước đó: 1.40 (T604: trigger `webhook.received` §11.2 — hook chưa xoá cùng base, `condition` phải `null`, chỉ base admin; giá trị `{ "trigger": body|headers|query }` và tham chiếu template `[@body.<path>]`/`[@headers.<tên>]`/`[@query.<path>]` §11.4 đọc dòng request (header nhạy cảm theo `INCOMING_WEBHOOK_SENSITIVE_HEADERS` luôn `null`, dòng đã dọn → `trigger_data_expired`); §11.6 đơn vị kích hoạt `webhook:<hok>:<giây epoch>` khi không có causation hợp lệ (ADR-35 §5 sửa ADR-26 §5); ghi của run mang `via.incoming_webhook_id`). Trước đó: 1.39 (T609: bảng `meta.telegram_webhooks` §5.10 (migration 0046); chế độ webhook tuỳ chọn của bot thông báo, trả lời qua bucket của bot + trần "không hợp lệ", poll thưa 15 phút — trỏ C§22.7, §12.2; §14.1 thêm tra cứu vượt tenant `findTelegramWebhookByPathHash`, `listTelegramBotsForSparsePoll`, `listTelegramWebhooksToCheck`). Trước đó: 1.38 (T603: route công khai `POST /api/v1/hooks/:token` và nghe mẫu §13.2/§11.4 trỏ C§25.2–§25.3 (thứ tự kiểm ADR-35 §1, Valkey không sẵn sàng → `503`, replay ghi dòng `duplicate`, event `webhook.received` actor `webhook` không audit, causation `depth + 1` chặn ở 5); §19 metric `webhook_requests_total{result}`, `webhook_request_duration_seconds`, `automation_causation_rejected_total{reason}`). Trước đó: 1.37 (T605: outbox hai pha cho HTTP ra — `meta.http_deliveries` §5.10, bước/run chờ giao như `delay` và thử lại 6 lần + `Retry-After` của outbox §11.7, `webhook-id` = id dòng giao §13.3, tra cứu vượt tenant `measureHttpDeliveryBacklog` + nhánh dọn dòng `test` của `purgeExpiredOperationalRows` §14.1, gauge `http_delivery_oldest_pending_seconds` + metric worker chưa phơi §19). Trước đó: 1.36 (T602: `meta.incoming_webhooks` theo ADR-35 §1 (`token_hash` + `token_enc`, secret ký mã hoá + secret cũ 24 h, `bearer_hash`, `auth` khớp credential, xoá mềm) và `meta.incoming_webhook_requests` (giữ 7 ngày, dedupe `webhook-id`) §5.10; §13.2 trỏ C§25.1; §14.1 thêm `findIncomingWebhookByTokenHash` và nhánh dọn request của `purgeExpiredOperationalRows`). Trước đó: 1.35 (T600: lõi mạng ra chống SSRF `packages/server-core/src/net/**` (resolve một lần, mọi địa chỉ phải được phép, ghim IP qua `lookup`, không follow redirect, 10 s/5 s, ≤ 1 MiB kể cả sau giải nén, không proxy), `meta.http_allowlist` theo tên host + `HostPacer` (org, host) §5.10, §14.3; env `HTTP_PRIVATE_ALLOWLIST` §20). Trước đó: 1.34 (backlog S5c: ADR-35 — webhook vào ghi thô rồi `202` (body ở bảng request 7 ngày, dedupe unique), HTTP ra qua outbox hai pha + nhịp theo host + `Retry-After`, lõi chống SSRF dùng chung không follow redirect + allowlist theo tên host, đơn vị kích hoạt `webhook.received` theo giây, gom thông báo theo nguồn webhook, chế độ webhook Telegram tuỳ chọn; §13.2, §13.3, §14.3, §22 dòng S5c — chi tiết do task S5c ghi). Trước đó: 1.33 (T560, hồi cứu S5b: ranh giới của `meta.date_reminder_cursors` là keyset (thời điểm + record cuối đã nhắc), lõi quét nhảy qua thay vì đọc lại — QA S5b M7 §5.10, §11.2; purge table xoá hàng `meta.notification_buffer` của table §5.10; lệch tài liệu: kênh `telegram` của `notification_preferences` §5.10, `channel.changed` trên `user:{id}` §15, quét nhắc một field lỗi không chặn field khác §11.2; không migration). Trước đó: 1.32 (T547: nhắc hạn field ngày — `datetime.options.reminder` §5.5; bảng `meta.date_reminder_cursors` §5.10 — migration 0041; bên tiêu thụ thứ hai của lõi quét `DateReminderScanner` + cron `notifications.date_reminder_scan` §11.2; tra cứu vượt tenant `listDateReminderFields` §14.1). Trước đó: 1.31 (T550: kênh `telegram` của `meta.notification_deliveries` được gửi — outbox email/Telegram, mã `error_code` Telegram ở C§22.4 — §5.10; `send_telegram` dùng chung giới hạn 25 tin/giây mỗi bot với thông báo qua Telegram, bucket Valkey theo id bot — §11.5; không migration, không env mới). Trước đó: 1.30 (T551: route `POST /automations/:id/duplicate` trong danh sách API và đoạn "Quyền chạy" §11 — bản sao tắt, người nhân bản là `run_as`, ảnh thân thư được chép; không đổi bảng). Trước đó: 1.29 (T544: `notify_on_assign` của field `user` có hiệu lực §5.5 — người được thêm vào nhận `record.assigned` (ghi hàng loạt gom một thông báo mỗi người mỗi `batch.id`) và tự theo dõi record; không bảng, không migration). Trước đó: 1.28 (T546: lõi quét thời gian dùng chung `packages/server-core/src/time-scan` — `TimeScanCore`, kho con trỏ, `dueRuleOf`; `record.date_reached` chạy trên lõi không đổi hành vi; ngữ cảnh quét hệ thống `RecordQueryService.systemScanAccess` + `scanDue` trả ô của field được nêu — §11.2). Trước đó: 1.27 (T549: bảng `meta.user_channels`, `meta.user_channel_link_tokens` và CHECK kênh `telegram` của `notification_preferences`/`notification_deliveries` §5.10 — migration 0040; tra cứu vượt tenant `listOrganizationsWithPendingTelegramLinks` §14.1). Trước đó: 1.26 (T543: bảng `meta.record_follows` + cột `auto_follow_created`, `auto_follow_assigned` của `meta.notification_settings` §5.10 — migration 0039). Trước đó: 1.25 (T542: bảng `meta.notification_buffer` §5.10 — migration 0038; tra cứu vượt tenant `listStaleNotificationBuffers` §14.1; dòng S5b của §22 thêm phần ngoài phạm vi). Trước đó: 1.24 (T541: `SMTP_MAX_PER_SEC` là cửa sổ trượt 1 giây trên cả giao dịch SMTP, không còn vọt 2×; hạn mức email Valkey chờ kết nối rồi lỗi tạm — §20). Trước đó: 1.23 (backlog S5b: ADR-34 — lõi quét thời gian dùng chung tách khỏi automation, gom `record.assigned` theo `batch.id` và `record.followed_changed` theo record, kênh Telegram cá nhân qua bot của org; §5.5, §5.10, §11.2, §22 dòng S5b). Trước đó: 1.22 (T528: index `meta.events (organization_id, entity_id, created_at)` §5.10 — migration 0037; khoảng giá trị env email/automation §20 theo code). Trước đó: 1.21 (T527: `record.matches` đọc các thay đổi sau của record khi event được dispatch muộn — §11.2). Trước đó: 1.20 (T516: `meta.secrets` + `meta.secret_bases` §5.10 — secret cấp org có phạm vi base, migration 0036; action `send_telegram` §11.5). Trước đó: 1.19 (T534: ảnh nhúng CID trong thư automation — logo chữ ký, ảnh thân thư upload, ảnh field attachment của record trigger, luôn là phần `inline` + `cid:`, không URL — §11.5; bảng `meta.email_assets` §5.10 (migration 0035); env `EMAIL_MAX_INLINE_IMAGES` §20; tra cứu vượt tenant `listExpiredEmailAssets` §14.1). Trước đó: 1.18 (T517: field `button` — chỉ meta, ô tính theo người xem `{ state, reason }`, không filter/sort/group/form/import/đổi kiểu, export ra nhãn §5.5; trigger `button.clicked` — bấm qua `POST …/buttons/:fieldId/click`, kiểm `404` → `min_permission` → bật/điều kiện, event + run bằng `run_as` với `clicked_by`/`clicked_at`, một automation mỗi nút, rate limit, share link không bấm được §11.2; migration 0034 `fields_type_check` + `automations_button_field_key` §5.10). Trước đó: 1.17 (T521b: tham chiếu template `[@actor]`, `[@previous].[fld_…]` và dữ liệu trigger `actor` §11.4). Trước đó: 1.16 (T532: đính kèm tệp trong `send_email` §11.5, env `EMAIL_MAX_ATTACHMENTS`/`EMAIL_MAX_ATTACHMENT_BYTES` §20, giới hạn theo org ≤ trần instance). Trước đó: 1.15 (T508: trigger thời gian `schedule` + `record.date_reached` — cron 5 trường theo timezone, tối thiểu 5 phút, lần bắn bị lỡ chỉ bắn lần gần nhất; quét cửa sổ `(con trỏ, now]` theo index cột ngày, dedupe theo giá trị, chỉ thời điểm sau khi bật — §11.2; `automations.trigger_armed_at`, `automation_time_cursors`, `automation_runs.trigger_key` §5.10, migration 0033; tra cứu vượt tenant `listTimeTriggerAutomations` §14.1). Trước đó: 1.14 (T518: lịch sử chạy automation — `rerun_of_run_id`/`rerun_by_user_id` của `automation_runs` §5.10 (migration 0032), chạy lại/huỷ/thời hạn lưu §11.7, env `AUTOMATION_RUN_RETENTION_DAYS` §20, tra cứu vượt tenant `listOrganizationsWithExpiredAutomationRuns` §14.1). Trước đó: 1.13 (T506: `update_records` theo filter có giá trị §11.4, đếm trước + ghi theo lô có tiến độ; `delay` theo `minutes` hoặc `until`, run `waiting` + job hẹn giờ, kiểm lại → `skipped`, tắt automation → `cancelled` — §11.5, §11.7). Trước đó: 1.12 (T514: `send_email` §11.5 — người nhận, Reply-To chỉ danh tính đã xác minh hoặc user Cellhive, body Markdown nhận `digest` qua `{{ [@digest] }}`, xem trước theo quyền người sửa + gửi thử; chi tiết C§21). Trước đó: 1.11 (T510: trigger `record.matches` bắn khi record chuyển từ không khớp sang khớp — tạo, sửa, khôi phục, giá trị computed `stored` tính lại; ảnh "trước" dựng từ `changes` của event, không lưu trạng thái — §11.2; tính lại sinh event cả cho `record.matches` có điều kiện nêu field đó §5.9). Trước đó: 1.10 (T505: engine `automation.run` §11.1/§11.7 — `active_ms`/`running_since` của `automation_runs` §5.10 (migration 0031), template đọc dữ liệu trigger và record của bước trước `[@…]`/`[act_…]` §11.4/§11.8). Trước đó: 1.9 (T509: giá trị computed `stored` tính lại sinh `record.updated` cho automation theo dõi chúng — §5.9, §11.2, §11.6; hàng đợi tính lại giữ `causation` + cờ `created` §5.10, migration 0030). Trước đó: 1.8 (T502: lộ trình §22 theo "Quyết định S5" — S5 lõi automation + email + thông báo trong app + button, S5b phần còn lại của thông báo, gói webhook/HTTP thành S5c; `button` vào MVP §5.5; `record.matches`, `button.clicked` vào §11.2; bảng automation §5.10 theo migration 0027). Trước đó: 1.7 (T471: đồng bộ sau S4b — preview REGEX qua server §9.4, số case fixture chung §9.4). Trước đó: 1.6 (T470: tham số ngày nhận chuỗi theo quy tắc TODATE ở cả hai backend §9.2/§9.3/§9.4). Trước đó: 1.5 (ADR-16…31; T422: đồng bộ với S4 đã merge — xoá cứng record trong audit §14.4, `allow_download` và rate limit tệp qua share link §15A, link/`parent`/attachment trong import/export §17). Trước đó: 1.4 (ADR-16…29; automation `run_as`, lô và breaker, đổi chiều link, thông báo/phê duyệt/bình luận)
Date: 2026-10-25
Status: **Approved for implementation** — mọi quyết định kiến trúc bên dưới là quyết định chốt, không phải gợi ý.

> Tài liệu này là nguồn sự thật (source of truth) cho kiến trúc; `CONTRACTS.md` là nguồn sự thật cho định dạng dữ liệu/API/lỗi/quyền; `BACKLOG.md` là danh sách việc; `AGENTS.md` là quy tắc làm việc. Nếu code hiện có mâu thuẫn với tài liệu, dừng lại và báo cáo, không tự "sửa cho khớp" theo ý mình. Mọi thay đổi kiến trúc phải thêm một ADR mới vào `docs/adr/`.

---

## 0. Cách đọc tài liệu này

- **MUST / MUST NOT**: bắt buộc. Vi phạm = task chưa hoàn thành.
- **SHOULD**: mặc định phải làm, chỉ bỏ qua khi ghi lý do trong PR.
- **Phase 2**: không làm trong MVP. Không tạo code, bảng, endpoint "chờ sẵn" cho Phase 2 trừ khi ghi rõ ở đây.
- Mọi ID trong ví dụ (`tbl_…`, `fld_…`) là minh hoạ.

---

## 1. Mục tiêu & phạm vi

Nền tảng web self-hosted kiểu Lark Base/Airtable: database no-code, nhiều view, dashboard, automation, API/webhook, phân quyền chi tiết, AI. Sản phẩm độc lập, không sao chép mã, thương hiệu hoặc tài sản của Lark.

Đây là **dự án mã nguồn mở công khai cho mọi người**, không phải công cụ nội bộ của một công ty. Người dùng mục tiêu: bất kỳ cá nhân/đội nhóm/doanh nghiệp nào tự host, từ 1 user đến vài trăm user trên một deployment.

Khác biệt cốt lõi so với Teable, Baserow, NocoDB, APITable:
1. **Toàn bộ tính năng là open source, không có Enterprise Edition, không feature gate.** Những thứ các dự án khác thu phí (SSO/OIDC, phân quyền field/record, audit log, AI, automation nâng cao, không giới hạn số dòng/số automation) đều nằm trong core.
2. Self-hosted dễ: một lệnh `docker compose up`, chạy được trên máy 2 GB RAM cho nhóm nhỏ, image amd64 + arm64.
3. Dữ liệu nằm trong bảng PostgreSQL thật, BI tool đọc trực tiếp được; xuất toàn bộ dữ liệu bất cứ lúc nào (không lock-in).
4. AI tuỳ chọn, chạy được hoàn toàn bằng LLM local (OpenAI-compatible endpoint); hệ thống đầy đủ chức năng khi không có AI.
5. Tích hợp mở: REST API + OpenAPI, webhook ký HMAC, n8n, Telegram, email.
6. i18n từ đầu: tiếng Anh là ngôn ngữ gốc, tiếng Việt là bản dịch hạng nhất (sort/tìm kiếm không dấu, định dạng VND).

### Không làm trong MVP
Messenger, Docs editor, spreadsheet engine đầy đủ, BPMN, thực thi code tuỳ ý (JS/Python) phía server, microservices, mobile native, offline-first, Gantt/Timeline, Calendar, Gallery, plugin system, multi-region, link giữa các base khác nhau, sơ đồ tổ chức (quản lý/phòng ban).

Phê duyệt trong base (S10) và bình luận/@mention trên record (S11) nằm trong lộ trình v0.2, ngay sau release v0.1.0 (§22, ADR-29). Không thuộc tiêu chí MVP §23. Hạ tầng thông báo (S5b) thuộc MVP.

---

## 1A. Nguyên tắc mã nguồn mở (bắt buộc)

- **License: AGPL-3.0-only** cho toàn bộ repo (trừ `packages/contracts` và SDK client nếu có: Apache-2.0, để người dùng tích hợp không bị ràng buộc AGPL).
  - Lý do chọn AGPL thay vì MIT/Apache: mục tiêu là "mọi tính năng miễn phí mãi mãi". Với MIT, bên thứ ba có thể fork, thêm tính năng đóng và bán dịch vụ cloud mà không trả lại cộng đồng. AGPL buộc mọi bản sửa đổi chạy dưới dạng dịch vụ mạng phải công bố mã nguồn.
- **Không CLA, dùng DCO** (`Signed-off-by` trong commit). CLA cho phép chủ dự án đổi license về sau (NocoDB đã chuyển từ AGPL sang source-available năm 2026). Không có CLA = bản quyền thuộc về từng contributor → không ai có thể đơn phương đóng mã. Đây là cam kết có thể kiểm chứng, không chỉ là lời hứa.
- **Không có code kiểm tra license key, không có cờ `isEnterprise`, không có thư mục `ee/`/`premium/`.** Agent MUST NOT tạo bất kỳ cơ chế giới hạn tính năng, giới hạn số user/dòng/automation theo "gói". Giới hạn duy nhất là giới hạn kỹ thuật cấu hình được bởi admin (rate limit, kích thước file…).
- **Không telemetry mặc định.** Nếu có, phải opt-in, tài liệu hoá chính xác dữ liệu gửi đi, và có thể tắt bằng env.
- **Không phụ thuộc dịch vụ bên ngoài bắt buộc.** Chạy được hoàn toàn offline/air-gapped (trừ khi admin cấu hình SMTP, LLM, webhook ra ngoài). Không load font/script từ CDN.
- Mọi dependency phải có license tương thích AGPL-3.0. Allowlist **chính xác** (SPDX) dùng cho CI: `MIT`, `MIT-0`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `0BSD`, `Apache-2.0`, `MPL-2.0`, `LGPL-2.1-or-later`, `LGPL-3.0-or-later`, `GPL-3.0-or-later`, `AGPL-3.0-only`, `AGPL-3.0-or-later`, `Python-2.0`, `BlueOak-1.0.0`, `Zlib`, `Unlicense`, `CC0-1.0`, `CC-BY-4.0` (chỉ cho gói dữ liệu, vd `caniuse-lite`), `OFL-1.1` (chỉ cho font). Biểu thức SPDX: `OR` đạt nếu một vế đạt, `AND` cần mọi vế đạt, `A WITH <exception>` tính như `A`. Thêm license = sửa danh sách này trong cùng PR. Allowlist và ngoại lệ theo gói nằm trong `tools/ci/license-policy.json`. CI chạy kiểm tra license (`pnpm licenses list --json` có sẵn của pnpm + `pnpm licenses:check`), fail nếu có license không tương thích hoặc không rõ.
- Tên và thương hiệu trung lập, không gắn với công ty nào. Không dùng tên/logo/tài sản của Lark, Airtable.
- Ngôn ngữ repo: code, comment, commit message, tên API, thông báo lỗi dạng `code` bằng **tiếng Anh**. Chuỗi UI qua i18n (`en` gốc, `vi` đầy đủ trong MVP). Tài liệu người dùng: `docs/en` + `docs/vi`.

### File cộng đồng bắt buộc có từ S0
`AGENTS.md` (quy tắc cho coding agent), `LICENSE`, `README.md` (en) + `README.vi.md`, `CONTRIBUTING.md` (DCO, quy trình PR, chạy dev), `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md` (báo lỗ hổng riêng tư, thời hạn phản hồi), `GOVERNANCE.md` (ai merge, cách ra quyết định, roadmap công khai), `CHANGELOG.md` (Keep a Changelog), template issue/PR.

### Phát hành
- Semantic Versioning. Mỗi release: image Docker multi-arch (amd64, arm64) trên GHCR, ký bằng cosign, kèm SBOM.
- **Nâng cấp an toàn là yêu cầu hạng nhất** vì người lạ tự host: migration chỉ tiến (forward-only), mỗi release minor phải nâng cấp được từ release minor trước đó; CI có test "cài bản N-1 → nạp dữ liệu mẫu → nâng lên bản N → chạy test".
- Không phá vỡ `/api/v1` trong cùng major version.

## 2. Quyết định kiến trúc (ADR tóm tắt)

| # | Quyết định | Lý do ngắn |
|---|---|---|
| ADR-01 | Modular monolith, TypeScript end-to-end, monorepo pnpm + Turborepo | Formula engine và filter DSL phải chạy cả client (preview) lẫn server → dùng chung package TS |
| ADR-02 | Frontend: **Vite + React SPA** (không dùng Next.js) | App dạng grid/editor, không cần SSR; bỏ một runtime server thừa |
| ADR-03 | Backend: **NestJS + Fastify adapter** | Module hoá rõ, DI, phù hợp modular monolith |
| ADR-04 | DB access: **Kysely** cho mọi truy vấn; migration meta schema bằng Kysely Migrator (file versioned). **Không dùng Prisma/Drizzle** | Bảng dữ liệu được tạo động lúc runtime; Prisma không xử lý được schema động |
| ADR-05 | **Mỗi user-table = một bảng PostgreSQL thật, mỗi field = một cột thật** (schema `data`). **Không** dùng `records.data JSONB` | Xem §5.1 |
| ADR-06 | Job/queue: **graphile-worker** (chạy trên PostgreSQL). **Không dùng BullMQ** | Enqueue job trong cùng transaction với mutation → outbox có sẵn, không dual-write |
| ADR-07 | Valkey (thay Redis, xem ADR-17) chỉ dùng cho: realtime pub/sub, cache dashboard, rate limit | Không đặt dữ liệu cần bền vững vào Valkey |
| ADR-08 | Grid UI: **@glideapps/glide-data-grid** (canvas) | Grid DOM (TanStack Table) không đạt trải nghiệm spreadsheet ở hàng chục nghìn dòng + copy/paste/fill. Rủi ro đã biết: bản npm 6.0.3 không release mới từ 2023 → bọc grid sau một adapter trong `apps/web`, sẵn sàng fork (MIT) nếu cần vá |
| ADR-09 | Một **Filter DSL** duy nhất dùng chung cho: view filter, record permission rule, automation condition, dashboard widget, AI query | Một compiler SQL + một evaluator in-memory, không có 5 hệ điều kiện khác nhau |
| ADR-10 | Auth tự xây: email/password (argon2id) + session server-side trong Postgres + OIDC generic (Keycloak / Azure AD / Google). **Không dùng Auth.js** | Auth.js gắn với Next.js; OIDC generic đủ để nối Keycloak/AD |
| ADR-11 | Contracts: **zod** schemas trong `packages/contracts`, sinh OpenAPI 3.1 từ zod | Một định nghĩa cho validate server, type client, tài liệu API |
| ADR-12 | AI: provider-agnostic qua OpenAI-compatible API; AI **không bao giờ sinh SQL**, chỉ sinh Filter DSL / Query DSL / Automation JSON rồi validate bằng zod | Chặn injection, bảo đảm đi qua permission |
| ADR-13 | Chart: Apache ECharts. UI kit: Tailwind + shadcn/ui. State: TanStack Query (server state) + Zustand (UI state). DnD: dnd-kit | |
| ADR-14 | Không dùng PostgreSQL RLS trong MVP; cô lập tenant bằng repository layer bắt buộc truyền `organizationId` + test | RLS khó áp cho bảng động; để Phase 2 cho meta schema |
| ADR-15 | AGPL-3.0-only + DCO, không CLA, không feature gate (xem §1A) | Bảo đảm dự án mở vĩnh viễn |
| ADR-16 | Object storage mặc định: **Garage** (S3 API, AGPL-3.0) thay MinIO; profile `minimal` dùng `STORAGE_DRIVER=local` | MinIO community đã archive (02/2026), không còn image — `docs/adr/0016` |
| ADR-17 | **Valkey 8** (BSD-3) thay Redis 7 | Redis 7.4+ là RSAL/SSPL, không phải OSI — `docs/adr/0017` |
| ADR-18 | graphile-worker: **không** dùng named queue theo org; giới hạn song song theo org bằng đếm run đang chạy | Named queue = concurrency 1 → một org bị chặn toàn bộ — `docs/adr/0018` |
| ADR-19 | **PostgreSQL 18** là phiên bản hỗ trợ duy nhất trong MVP | Thống nhất tài liệu (trước ghi 16/17), `LIKE` trên nondeterministic collation, `uuidv7()`, AIO — `docs/adr/0019` |
| ADR-20 | Ngân sách cột vật lý + job compaction bảng dữ liệu | PG giới hạn 1.600 cột, cột đã drop vẫn bị tính — `docs/adr/0020` |
| ADR-21 | Hàm SQL của formula nhận timezone tường minh; không phụ thuộc `TimeZone` của session | Bảo đảm `IMMUTABLE` thật sự, giá trị `stored` xác định — `docs/adr/0021` |
| ADR-22 | Webhook ra ngoài ký theo **Standard Webhooks** | Chuẩn có thư viện verify sẵn cho nhiều ngôn ngữ — `docs/adr/0022` |
| ADR-23 | Audit log + lịch sử record: gom theo `batch_id`, nguồn `via`, `__deleted_by`, lọc theo quyền hiện tại, append-only, retention, redact | Trả lời được "ai xoá/sửa ô nào, lúc nào" mà không lộ field bị ẩn — `docs/adr/0023` |
| ADR-24 | Gói `.chbase` để xuất/nhập nguyên một base, đổi toàn bộ ID khi nhập | Tiêu chí MVP 12, không lock-in — `docs/adr/0024` |
| ADR-25 | Automation chạy bằng quyền của **người bật/sửa cuối** (`run_as`); sửa = nhận `run_as`; `run_as` mất quyền → tắt ngay, báo admin base, cho phép nhận quản lý | Chạy bằng quyền `created_by` cho phép leo thang quyền — `docs/adr/0025` |
| ADR-26 | Event mang `batch` + `via`; circuit breaker đếm theo đơn vị kích hoạt (lô/`root_event_id`); tuỳ chọn `skip_bulk`; trần fan-out mỗi lô | Dán/import 1.000 dòng không được tắt nhầm automation hợp lệ — `docs/adr/0026` |
| ADR-27 | `http_request` gửi token causation mã hoá; `/hooks/:token` nối tiếp `depth`/chain | Vòng lặp qua webhook của chính instance, chặn theo URL không đủ — `docs/adr/0027` |
| ADR-28 | Đổi link một chiều ↔ hai chiều qua luồng đổi kiểu; tối đa 500 liên kết mỗi ô | Hai phía dùng chung junction nên đổi chiều không chép dữ liệu — `docs/adr/0028` |
| ADR-29 | Hạ tầng thông báo (S5b), phê duyệt trong base với khoá record (S10), bình luận + @mention (S11) | Khoảng trống lớn nhất so với Lark; dùng lại event, worker, audit, realtime — `docs/adr/0029` |
| ADR-30 | Chống spam form không dùng dịch vụ ngoài: submit token ký, honeypot, rate limit | Không captcha bên thứ ba (§1A) — `docs/adr/0030` |
| ADR-31 | Subscription `table:` theo view đang mở: server đánh giá filter view (kể cả điều kiện ẩn) | Realtime đúng phạm vi view, không lộ điều kiện ẩn — `docs/adr/0031` |

---

## 3. Kiến trúc tổng thể

```text
Browser (Vite React SPA)
   │  REST (JSON)            WebSocket
   ▼                          ▼
nginx/caddy ──► api (NestJS, stateless, N instances)
                   │ modules: auth, org, workspace, base, schema, record,
                   │          query, view, form, dashboard, automation,
                   │          file, ai, audit, realtime, integration
                   ├──► PostgreSQL 18 (meta schema + data schema + fx schema + graphile_worker schema)
                   ├──► Valkey 8 (pub/sub, cache, rate limit)
                   └──► Object storage S3 API (Garage mặc định) hoặc local volume
worker (NestJS standalone app, graphile-worker runner) ──► cùng Postgres/Valkey/storage + outbound HTTP/SMTP/LLM
```

- `api` và `worker` là hai entrypoint của **cùng codebase** (`apps/api`, `apps/worker` import chung `packages/*` và các NestJS module dùng chung trong `packages/server-core`).
- Không có service thứ ba trong MVP.

---

## 4. Monorepo

```text
cellhive/
├── apps/
│   ├── web/                 # Vite React SPA
│   ├── api/                 # NestJS HTTP + WebSocket
│   └── worker/              # graphile-worker tasks
├── packages/
│   ├── contracts/           # zod schemas, DTO, OpenAPI generation
│   ├── field-types/         # định nghĩa field type: PG type, validate, format, convert
│   ├── filter-dsl/          # AST types, validator, SQL compiler (Kysely), in-memory evaluator
│   ├── formula-engine/      # lexer, parser, typechecker, evaluator (pure TS, không phụ thuộc Node API)
│   ├── markdown/            # Markdown hẹp dùng chung web + email (T529, ADR-32 §3): parser → AST, template `{{ }}` (parse trước, thay giá trị thành node text; tách `{{ }}` bằng scanner chung `@cellhive/formula-engine/template/split` — T504), renderer HTML allowlist + text/plain; thuần, không Node built-in/DOM
│   ├── permissions/         # resolver thuần (input: principal + ACL data → quyết định)
│   ├── automation-core/     # definition schema, template rendering, loop guard
│   ├── server-core/         # NestJS modules dùng chung api+worker (db, schema service, query engine, audit, events)
│   └── ui/                  # component dùng chung
├── infra/
│   ├── docker/              # Dockerfile từng app
│   └── garage/              # garage.toml (dev), garage.prod.toml, storage-init.sh
├── docs/
│   ├── SPEC.md              # tài liệu này
│   ├── CONTRACTS.md         # định dạng API/record/lỗi/quyền
│   ├── BACKLOG.md           # danh sách task
│   ├── FRONTEND.md          # kiến trúc frontend
│   ├── adr/
│   ├── en/                  # tài liệu người dùng + self-host
│   └── vi/
├── docker-compose.yml
├── docker-compose.dev.yml
└── README.md
```

Các package thuần (`field-types`, `filter-dsl` evaluator, `formula-engine`, `permissions`, `automation-core`) **MUST NOT** import NestJS, pg, hay Node built-in → chạy được trên browser và có unit test độc lập.

---

## 5. Lưu trữ dữ liệu

### 5.1 Vì sao bảng thật thay vì JSONB

Bản 0.1 đề xuất `records.data JSONB` với lý do "không tối ưu sớm". Quyết định này bị bác vì:
- Đây là quyết định **không đảo ngược được** về sau (đổi = viết lại query engine + migrate toàn bộ dữ liệu), nên không phải "tối ưu sớm" mà là nền móng.
- PostgreSQL không có thống kê (statistics) cho từng key trong JSONB → planner ước lượng sai khi filter/sort/aggregate, dashboard chậm dần theo dữ liệu.
- Filter/sort số/ngày trên JSONB cần cast ở mọi query; index phải là expression index theo từng field → vẫn phải chạy DDL động, mất luôn lợi thế "không DDL".
- Link/lookup cần join; FK và junction table trên bảng thật đơn giản và đúng hơn.
- PostgreSQL hỗ trợ **transactional DDL**: tạo/sửa cột và cập nhật meta trong cùng một transaction → nhất quán tuyệt đối.
- BI tool (Metabase/Grafana/Superset) đọc trực tiếp được bảng thật.

Rủi ro đã biết và cách giảm: DDL giữ lock → mọi DDL đi qua `SchemaService`, `SET LOCAL lock_timeout = '3s'`, advisory lock theo table, retry có giới hạn; đổi kiểu cột trên bảng lớn chạy dạng job nền (xem §5.5).

### 5.2 Schemas PostgreSQL

- `meta` — metadata hệ thống (org, user, base, table, field, view, permission, automation, …).
- `data` — bảng dữ liệu người dùng, tên sinh tự động.
- `graphile_worker` — do graphile-worker quản lý.

- `fx` — hàm SQL của formula engine (§9.4), tạo bằng migration.

Extensions bắt buộc: `pgcrypto`, `pg_trgm`, `unaccent`, `citext` (đều là trusted extension, chủ DB tạo được, không cần superuser). Extensions, schema `meta`/`data`/`fx` và hàm `meta.f_unaccent` được tạo trong **migration 0001** (chạy được trên Testcontainers và Postgres được quản lý); `infra/postgres/init.sql` chỉ dùng cho compose dev nếu cần tạo database/role. Image Postgres phải có ICU (image `postgres:18` chính thức có sẵn). Lưu ý image 18+: volume mount tại `/var/lib/postgresql` (không phải `/var/lib/postgresql/data`), xem ADR-19.

```sql
-- Hàm unaccent IMMUTABLE để dùng được trong index
CREATE OR REPLACE FUNCTION meta.f_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
```

### 5.3 Quy ước tên

- Bảng dữ liệu: `data.t_<tableShortId>` (shortId = 12 ký tự base36 **chữ thường** để dùng làm identifier không cần ngoặc kép, sinh ngẫu nhiên, lưu trong `meta.tables.db_table_name`).
- Cột field: `f_<fieldShortId>` (lưu trong `meta.fields.db_column_name`).
- Junction table cho link: `data.l_<fieldShortId>`.
- **MUST NOT** dùng tên do người dùng đặt trong bất kỳ identifier SQL nào. Identifier SQL chỉ lấy từ meta và luôn qua `sql.id()` của Kysely.

### 5.4 Cột hệ thống của mỗi bảng dữ liệu

```sql
CREATE TABLE data.t_xxxxxxxxxxxx (
  __id          text PRIMARY KEY,            -- 'rec_' + 16 ký tự base62, sinh ở app (CONTRACTS §1.2)
  __auto        bigint GENERATED ALWAYS AS IDENTITY,  -- dùng cho autonumber + thứ tự mặc định
  __created_at  timestamptz NOT NULL DEFAULT now(),
  __updated_at  timestamptz NOT NULL DEFAULT now(),
  __created_by  text,                         -- user id; null = system/automation
  __updated_by  text,
  __version     integer NOT NULL DEFAULT 1,   -- optimistic concurrency
  __deleted_at  timestamptz,                  -- soft delete (thùng rác 30 ngày)
  __deleted_by  text                          -- ai đưa vào thùng rác (ADR-23)
);
CREATE INDEX ON data.t_xxxxxxxxxxxx (__created_at);
CREATE INDEX ON data.t_xxxxxxxxxxxx (__deleted_at) WHERE __deleted_at IS NOT NULL;
```

Mọi truy vấn record mặc định thêm `__deleted_at IS NULL`.

- Field bật `unique_values` → **partial** unique index `WHERE __deleted_at IS NULL` (record trong thùng rác không chặn giá trị mới). Khôi phục record (`restore`) phải kiểm tra lại unique; trùng → `422 UNIQUE_VIOLATION`.
- **Ngân sách cột** (ADR-20): PostgreSQL giới hạn 1.600 cột/bảng và cột đã `DROP` vẫn chiếm slot vĩnh viễn (kể cả sau `VACUUM FULL`). Mỗi lần đổi kiểu hoặc xoá field tiêu thêm slot. Giới hạn:
  - Tối đa **500 field đang hoạt động/table** (env `MAX_FIELDS_PER_TABLE`, trần cứng 1.000) → vượt: `422 FIELD_LIMIT_EXCEEDED`.
  - `SchemaService` đếm slot vật lý = `count(*) FROM pg_attribute WHERE attrelid = <table> AND attnum > 0` (**gồm** `attisdropped`). ≥ 1.400 → tự enqueue job `schema.compact_table`; ≥ 1.550 → từ chối DDL tiêu slot với `409 SCHEMA_LOCKED` cho tới khi compaction xong.
  - Compaction = tạo bảng mới cùng cột đang dùng (giữ cột `__deleted_*` còn trong hạn khôi phục 30 ngày và `__old_*` còn trong hạn 7 ngày), copy dữ liệu, dựng lại index/FK junction, rồi đổi tên bảng mới về **tên cũ** nên `db_table_name` không đổi (chi tiết ADR-20).

### 5.5 Field types → kiểu PostgreSQL

Mô hình field theo Lark Base: **ít type, nhiều style**. Phone/url/email/barcode là `text` với `style.type`; tiền tệ/tiến độ/đánh giá/phần trăm là `number` với `style`; đơn chọn và đa chọn đều là `select` với `multiple`. Cách này giảm số cặp chuyển đổi kiểu và giữ dữ liệu khi đổi hiển thị.

| type | PG type | Cấu hình (`options`) |
|---|---|---|
| `text` | `text COLLATE <collation của base>` | `style.type`: `plain` (mặc định, cho phép nhiều dòng, markdown nhẹ), `phone`, `url`, `email`, `barcode`; `default_value`. Primary field mặc định là text; index trigram trên `meta.f_unaccent(lower(col))` cho primary field |
| `number` | `numeric` | `style.type`: `plain` {`precision` 0–4, `percentage`, `thousands_separator`}, `currency` {`precision`, `currency_code` ISO 4217}, `progress` {`percentage`, `color`}, `rating` {`icon`, `min` 0–1, `max` 1–10}; `default_value`. Phần trăm lưu dạng thập phân (20% = 0.2) |
| `select` | `text[]` + GIN index | `multiple` (mặc định false; khi false ràng buộc ≤ 1 phần tử), `options[]` {`id`, `name`, `color`}; `default_value`. Lưu **option id**, API nhận/trả **tên option** mặc định. Đổi tên option không rewrite dữ liệu. Tối đa 1.000 option (Phase 2: `dynamic_options_source` dùng lại option của field khác) |
| `datetime` | `timestamptz` (hoặc `date` khi `style.format` không có giờ) | `style.format` (danh sách định dạng cố định, vd `yyyy-MM-dd`, `dd/MM/yyyy`, `dd/MM/yyyy HH:mm`), `timezone` hiển thị (mặc định theo org); `default_value`: hằng số hoặc `{ "$slot": "record_created_time" }` (tự điền, vẫn sửa được); `reminder` (nhắc hạn, S5b, ADR-29 §1, ADR-34 §1, T547: `null` hoặc `{ offset_minutes ±43.200, time_of_day HH:MM chỉ field chỉ ngày (mặc định 09:00 theo timezone field → org), recipients: field_user + user_field_id (field `user`/`created_by` cùng table, đọc lúc nhắc) \| users + user_ids (1–50 thành viên org) }` — một nhắc mỗi field, lưu bằng quyền sửa schema, bật/đổi → vũ trang lại (không nhắc bù), quét bằng lõi quét thời gian dùng chung, quyền kiểm theo người nhận lúc gửi; C§2, C§22.6) |
| `checkbox` | `boolean NOT NULL DEFAULT false` | |
| `user` | `text[]` (user id) | `multiple` (mặc định true), `notify_on_assign` (gửi thông báo `record.assigned` cho người **được thêm** vào field — trừ người gây ra thay đổi — và họ tự theo dõi record; ghi hàng loạt gom một thông báo mỗi người mỗi `batch.id`; ADR-29 §1, ADR-34 §2, T544, CONTRACTS §22.2); `default_value`: `[{ "$slot": "current_user" }]` hoặc user id |
| `attachment` | `jsonb` | Mảng `{id,name,size,mime}` là cache hiển thị; nguồn thật là `meta.attachments`. `accept` (MIME whitelist), `max_files` |
| `created_at` / `updated_at` | — | Trỏ `__created_at`/`__updated_at`; `style.format`. Chỉ đọc |
| `created_by` / `updated_by` | — | Trỏ `__created_by`/`__updated_by`. Chỉ đọc |
| `auto_number` | `text` (giá trị đã format) + dựa trên `__auto` | `style.rules` 1–9 quy tắc: `{type:"text",text}`, `{type:"incremental_number",length 1–9}`, `{type:"created_time",date_format}`. Mặc định `NO.001`. Đổi rules → job tính lại toàn bộ số hiện có |
| `link` | junction `data.l_<fld>` | `link_table`, `bidirectional`, `allow_multiple`, `record_filter` (§5.6); tối đa 500 liên kết mỗi ô |
| `parent` | `__parent_id text` | Sub-record (§5.7) |
| `lookup` | cột thật hoặc ảo | `from`, `select`, `where`, `aggregate` (§5.8) |
| `formula` | cột thật hoặc ảo | `expression`, `style` định dạng kết quả (§5.9, §9) |
| `button` | — (không cột vật lý, không tiêu slot ADR-20; `meta.fields.db_column_name` luôn `NULL`) | `label` (mặc định "Run"), `color` (0–54, bảng màu nhãn), `confirm` (`{ title, message, confirm_label }` hoặc `null`). Chỉ đọc, không `unique_values`/`required`; không filter/sort/group/summary, không câu hỏi form, không import, không đổi kiểu (từ/sang), formula/template không tham chiếu được; ô = `{ state: ready \| disabled, reason }` tính cho từng người đọc (automation gắn nút, `min_permission` của người đọc, `enabled_when` bằng quyền `run_as` — CONTRACTS §2), `cell_format=text`/export = nhãn; bấm chạy automation trigger `button.clicked` bằng quyền `run_as` (§11.2, ADR-32 §2). S5 (T517) |

`default_value` chỉ hỗ trợ cho `text`, `number`, `select`, `datetime`, `user` (giống Lark).

Phase 2: `location` ({lng,lat,full_address}), `duration`, `dynamic_options_source`; nút `open_url` của `button` và button block trên dashboard. (`button` chạy automation: S5, BACKLOG "Quyết định S5" #5.)

**Đổi kiểu field** (cài ở T403; quyết định thiết kế S4 #7–#8 trong BACKLOG): whitelist chuyển đổi (dựa trên quy tắc của Lark Base) định nghĩa trong `CONTRACTS.md` §4 và cài đặt trong `packages/field-types`. Cặp ngoài whitelist chỉ cho phép khi cột rỗng hoặc người dùng xác nhận chấp nhận mất toàn bộ dữ liệu cột. `link` không chuyển sang/từ kiểu khác; đổi `bidirectional` của link đi qua luồng này (§5.6, ADR-28). Quy trình:
1. Trong transaction (kiểm ngân sách cột, 1 slot): `ADD COLUMN f_x__new_<epoch ms>` (cột bóng, kiểu mới, chưa ràng buộc), ghi `meta.field_conversions`, xếp job `field.convert` (queue `schema:<tableId>`, `acquireOrgSlot`). Field **giữ nguyên** định nghĩa và cột cũ trong lúc job chạy: ô hiện giá trị cũ, chỉ đọc (ghi record vào field và sửa schema field → `409 SCHEMA_LOCKED`); filter/sort/group theo field vẫn chạy trên giá trị cũ (UI tạm khoá sửa chúng).
2. Job nền backfill theo batch 5.000 dòng (mọi dòng, kể cả thùng rác) vào cột bóng bằng hàm thuần của `packages/field-types` (cùng hàm với preview); giá trị không chuyển được → NULL và đếm số lượng; tiến độ realtime `field.converting` cho mọi người đang mở base. Kết thúc (một transaction, khoá schema): `f_x` → `f_x__old_<epoch ms>` (bỏ CHECK/index), cột bóng → `f_x` (thêm CHECK/index mới), meta đổi kiểu (`unique_values = false`), một `field.converted` (audit có số đếm, không ghi audit/event theo record), `schema.changed` action `converted`. Job lỗi → xoá cột bóng, field không đổi.
3. Cột `__old_` giữ 7 ngày cho phép hoàn tác, sau đó cron `field.conversion_cleanup` drop. Hoàn tác (`POST /fields/:id/revert-conversion`): mặc định chỉ khôi phục ô **chưa sửa** sau khi đổi, ô đã sửa giữ giá trị (chuyển ngược về kiểu cũ; không chuyển được → giá trị cũ, báo số lượng); `overwrite_later_edits` ghi đè mọi ô (cần xác nhận khi có ô đã sửa); `new_field` khôi phục bản cũ thành field mới (không phá huỷ). (Mỗi lần đổi kiểu tiêu 1 slot cột vĩnh viễn — kiểm tra ngân sách cột §5.4 trước bước 1.)
4. API bắt buộc gọi dry-run trước (`POST /fields/:id/convert-preview`) trả số giá trị sẽ mất/bị cắt và 20 ví dụ; thực hiện thật cần `confirm=true` nếu có mất dữ liệu.
   Formula/lookup (T463, C§4.1/§4.4) đi cùng luồng: "chuyển thành giá trị tĩnh" chụp giá trị hiện tại vào cột bóng theo kiểu kết quả; kiểu bất kỳ → formula/lookup tính biểu thức vào cột bóng kiểu kết quả (`virtual`: không cột) trong lúc field vẫn hiện giá trị cũ, xong thì tính lại toàn bảng bằng `computed.recompute` (nguồn có thể đổi trong lúc job chạy); hoàn tác trả lại định nghĩa + cạnh phụ thuộc (vòng mới → `CIRCLE`, §9.4).
5. Đổi chỉ `style` (không đổi type) không chạm dữ liệu. Riêng `text` đổi `style.type` sang `email` hoặc `phone`: **không bao giờ xoá hay sửa giá trị cũ** (khác Lark, vốn xoá giá trị không hợp lệ). `convert-preview` (S4) trả `invalid` = số ô không khớp định dạng + tối đa 20 ví dụ; `PATCH` đổi style không cần `confirm`. Grid và panel record đánh dấu ô không hợp lệ (viền/biểu tượng cảnh báo, tính ở client bằng validator của `packages/field-types`, không lưu cờ trong DB). Ghi mới vẫn được chấp nhận như `plain`; UI cảnh báo khi nhập giá trị sai định dạng. Chặn ghi ở server để Phase 2. Ngoại lệ: đổi `style.format` của `datetime` giữa loại chỉ ngày và loại có giờ làm đổi kiểu cột (`date` ↔ `timestamptz`), nên đi qua luồng đổi kiểu (convert-preview, S4); trước S4, API trả `422 CONVERSION_NOT_ALLOWED` cho thay đổi này.

**Xoá field**: soft delete trong meta + rename cột thành `f_x__deleted_<epoch>`; khôi phục được trong 30 ngày (`POST /fields/:id/restore`), sau đó purge. Đổi kiểu hoàn tác được trong 7 ngày (`POST /fields/:id/revert-conversion`). Chi tiết ADR-23 §3.

### 5.6 Link (liên kết bảng này với bảng kia)

Theo mô hình Lark Base: field `link` có `link_table`, `bidirectional` (mặc định `false`, UI có checkbox "Liên kết hai chiều"), `bidirectional_link_field_name`, `allow_multiple` (mặc định `true`).

```sql
CREATE TABLE data.l_<fieldShortId> (
  a_id text NOT NULL REFERENCES data.t_<tableA>(__id) ON DELETE CASCADE,  -- bảng chứa field
  b_id text NOT NULL REFERENCES data.t_<tableB>(__id) ON DELETE CASCADE,  -- bảng đích
  position integer NOT NULL DEFAULT 0,       -- thứ tự hiển thị trong ô
  PRIMARY KEY (a_id, b_id)
);
CREATE INDEX ON data.l_<fieldShortId> (b_id);
```

- **Một chiều**: chỉ bảng A có field; bảng B không thấy gì.
- **Hai chiều**: tạo thêm field ở bảng B dùng **chung junction table** (đọc theo chiều ngược: `b_id → a_id`), `meta.fields.options.symmetric_field_id` trỏ nhau. Sửa ở bên nào thì bên kia thấy ngay (vì chung dữ liệu, không cần đồng bộ).
- **Đổi chiều (ADR-28)**: `bidirectional` đổi được sau khi tạo, qua luồng đổi kiểu (§5.5: `convert-preview` → `PUT /fields/:id` → job, `409 SCHEMA_LOCKED` trên field liên quan khi job chạy). Cần quyền sửa schema ở cả hai bảng.
  - Một chiều → hai chiều: tạo field ngược ở bảng B dùng chung junction (không chép dữ liệu, không sinh `record.updated`), `allow_multiple = true`, tên theo `bidirectional_link_field_name`.
  - Hai chiều → một chiều: field phía kia bị xoá mềm (khôi phục 30 ngày, `revert-conversion` 7 ngày); preview liệt kê formula/lookup/view/role/automation phụ thuộc sẽ hỏng; job tính lại computed field phụ thuộc.
  - Xoá một phía của link hai chiều → phía còn lại thành một chiều (như cũ).
  - `link` vẫn không chuyển đổi sang/từ kiểu khác (giống Lark).
- **Tối đa 500 liên kết mỗi ô**, áp cho mỗi phía (kể cả phía ngược). Vượt → `422 INVALID_CELL_VALUE` / `TOO_MANY_VALUES` (`params.limit`). Ô đã vượt do chuyển một chiều → hai chiều được giữ, chỉ gỡ được, không thêm được; preview báo `over_limit`.
- `allow_multiple=false` → unique index trên cột của phía field (`a_id`; `b_id` khi field ngược được chuyển sang một record). `allow_multiple` true → false qua luồng đổi kiểu (§5.5, CONTRACTS §4.2): mỗi ô giữ liên kết đầu, hoàn tác 7 ngày.
- Self-link (bảng liên kết chính nó) được phép.
- `options.record_filter` (Filter DSL, tuỳ chọn): giới hạn record được chọn trong ô picker (vd chỉ khách hàng đang "Hoạt động"). Chỉ ràng buộc UI + validate khi ghi.
- Hiển thị ô link = primary field của record đích. Bấm vào mở record đích.
- `position` là thứ tự ô ở phía tạo junction (`a_id`); phía ngược (`b_id`) liệt kê record theo thứ tự tạo (`__auto`) và thêm liên kết từ phía ngược thì nối vào cuối ô phía `a`. Meta của field link lưu tên junction và phía đọc (`meta.fields.link_junction`, `link_side`, migration 0011, T401); ngữ nghĩa đọc/ghi chi tiết ở CONTRACTS §2, §13.
- **Master–detail**: trong cửa sổ chi tiết record, field link hiển thị dạng **bảng con nhúng** (mini-grid các record liên kết, chọn cột hiển thị), cho phép thêm mới record đích ngay tại đó (tự gắn link), sửa inline, gỡ liên kết. Ví dụ: Đơn hàng → các dòng Chi tiết đơn hàng.
- Link giữa các base khác nhau: Phase 2.

### 5.7 Sub-record (bảng con dạng cây trong cùng table)

Giống tính năng sub-records trong grid của Lark Base.

- Bật "Sub-records" cho table → hệ thống tạo field `parent` (single self-link, lưu cột `__parent_id text REFERENCES data.t_x(__id) ON DELETE SET NULL` + index), và field ảo "Sub-records" hiển thị danh sách con.
- Độ sâu tối đa 10 cấp. Chặn vòng lặp: khi gán parent, kiểm tra bằng recursive CTE rằng parent mới không phải con cháu của record.
- Grid hiển thị dạng cây: thụt lề, mở/đóng nhánh, nút "+ Thêm sub-record", kéo thả để đổi cha. Sort áp dụng trong cùng cấp anh em.
- Filter trên view dạng cây: record khớp filter được hiển thị kèm tổ tiên của nó (tổ tiên không khớp hiển thị mờ) — cấu hình `config.tree.show_ancestors` (mặc định `true`).
- Xoá record cha: hỏi "xoá cả nhánh" hoặc "đưa con lên gốc" (mặc định).
- Formula/lookup dùng được: `[Parent].[Field]`, tổng hợp con qua lookup `where: Parent intersects current`.
- Kanban/dashboard bỏ qua cấu trúc cây (coi mọi record là phẳng).
- API: `POST /tables/:id/records` với `parent_id`; `GET /tables/:id/records/:recordId/children`; `POST /tables/:id/records/tree` (cây theo tầng: gốc phân trang + con theo nhánh mở) và `GET /tables/:id/records/:recordId/ancestors` (đường dẫn cha). Field `parent` không có `db_column_name` (giá trị ở `__parent_id`; migration 0014: tối đa một field `parent` chưa purge mỗi table); tắt sub-records = xoá field (cột được giữ để khôi phục). Ngữ nghĩa chi tiết (T405): CONTRACTS §1.4, §2, §11.3, §13.

### 5.8 Lookup (lấy và tổng hợp dữ liệu từ bảng khác)

Theo mô hình bốn thành phần của Lark Base — **không bắt buộc phải có link**:

```json
{
  "type": "lookup",
  "name": "Tổng tiền đơn đã hoàn thành",
  "from": "tbl_orders",
  "select": "fld_amount",
  "where": { "op": "and", "items": [
    { "field": "fld_customer_link", "operator": "intersects", "value": { "field_ref": "__id" } },
    { "field": "fld_status", "operator": "is", "value": "opt_done" }
  ]},
  "aggregate": "sum"
}
```

- `from`: table nguồn cùng base. `select`: field của bảng nguồn.
- `where`: Filter DSL trên field **của bảng nguồn**; value là hằng số hoặc `{ "field_ref": "<field của bảng hiện tại>" }` (so khớp theo từng dòng). Toán tử bổ sung cho lookup: `intersects`, `disjoint` (so sánh tập hợp: text/number/date → tập 1 phần tử, select/user/link → tập giá trị). `where` bắt buộc ít nhất 1 điều kiện (tránh mỗi dòng kéo cả bảng).
- `aggregate`: `raw_value` (mặc định, danh sách), `unique`, `sum`, `average`, `max`, `min`, `counta`, `unique_counta`.
- UI có lối tắt: chọn một field link → chọn field đích → hệ thống tự sinh `where` tương ứng.
- Lookup là field chỉ đọc, được biên dịch sang cùng SQL với formula `FILTER` (§9.4) và dùng chung cơ chế lưu/tính lại (§5.9).
- Lookup từ bảng nguồn không được xem (quyền) → giá trị hiển thị rỗng + biểu tượng khoá, không lộ dữ liệu. Áp cho mọi computed đọc **record khác** (lookup, `[Link].[Field]`, `[Table]…`, kể cả qua computed lồng nhau): người xem không đọc được table nguồn, field được lấy hoặc field trong điều kiện → ô `null`, field `locked: true` trong schema của người xem, filter/sort/group theo nó như field không thấy (C§1.4, C§13, P34). Người xem có record rule đọc trên table nguồn → giá trị **không** lấy từ cột `stored` mà tính `virtual` theo phạm vi đọc của chính họ (`sourceScope`, §9.4), filter/sort theo field đó cũng vậy (P35; Câu hỏi mở S4b #1, T457). Lookup field link/user trả như ô link/user (title theo P20 của người xem); lookup attachment trả `{ id, name, size, mime, thumbnail_url }`, tải kiểm quyền trên record/field nguồn; qua share link lookup attachment luôn `null` (Câu hỏi mở S4b #4).

### 5.9 Computed fields: lưu và tính lại

Formula và lookup đều là **computed field**, có một trong hai chế độ (hệ thống tự chọn, admin không cần cấu hình):

| Chế độ | Khi nào | Cách tính |
|---|---|---|
| `stored` | Biểu thức xác định (deterministic) | Lưu vào cột thật; filter/sort/aggregate/index như field thường |
| `virtual` | Có `NOW()`, `TODAY()`, `RANDOMBETWEEN`, `RANDOMITEM` hoặc phụ thuộc field `virtual` | Biểu thức SQL được chèn thẳng vào SELECT/WHERE/ORDER BY lúc đọc |

Field `stored` không được phụ thuộc field `virtual`… trừ khi chính nó chuyển thành `virtual` (tự động, thông báo trong UI).

**Dependency graph** (cấp base, lưu trong `meta.field_dependencies(field_id, depends_on_field_id, kind)` với kind = `same_row | via_link | cross_table`):
- Phát hiện vòng tham chiếu (kể cả vòng qua nhiều bảng) khi lưu định nghĩa → lỗi validate, nêu rõ chuỗi vòng.
- Khi field X của record R thay đổi, xác định các computed field bị ảnh hưởng và **dòng** bị ảnh hưởng:
  - `same_row` → chính R.
  - `via_link` → các dòng liên kết với R qua junction (đi ngược chuỗi link).
  - `cross_table` (FILTER/lookup theo điều kiện, không qua link) → các dòng ở bảng đích có giá trị `field_ref` khớp giá trị **cũ hoặc mới** của R trên field điều kiện; nếu điều kiện không có `field_ref` (hằng số thuần) → toàn bộ bảng đích.
- Phân tích phụ thuộc (`analyze`, T452): mỗi phụ thuộc là `{ field_id, kind, link_path, condition_refs }`. `same_row`: field của chính record (kể cả field link được đi qua); `via_link`: field của record đi tới qua `link_path` (id các field link, bậc đầu ở table của công thức); `cross_table`: field đọc từ `[Table]…`, FILTER/COUNTIF/SUMIF/MAP/SORTBY trên bảng, `LOOKUP`, lookup field (`link_path` tính từ các record đó). `condition_refs` = field của table công thức (hoặc `__id` cho `RECORD_ID()`) xuất hiện trong **vế khoá** của điều kiện: một hạng tử cấp cao nhất nối bằng `&&`/`AND` dạng `CurrentValue.[X] = [Field]` (hai chiều), `CONTAIN`/`CONTAINSALL(CurrentValue.[X], [Field], …)` chỉ gồm field, hoặc giá trị của `LOOKUP` là `[Field]`; không có vế khoá (điều kiện hằng, `||`, biểu thức trên field…) hoặc cùng field còn được đọc không điều kiện → `[]` = toàn bộ bảng. `referenced_tables` = mọi table có record được đọc (qua `[Table]` hoặc link, gồm table đích của link được so theo tiêu đề). Record được dùng như text (so với chuỗi, `&`, `ARRAYJOIN`, hàm text) đọc **tiêu đề** nên phụ thuộc thêm primary field của table đó, cùng `kind`/`link_path` với record (T456). `perf_warning = cross_table_scan` khi công thức `virtual` truy vấn table khác không qua field link nào của table đó (Câu hỏi mở S4b #11, editor cảnh báo).
- Tính lại bằng **SQL set-based**: `UPDATE data.t_x SET f_y = (<compiled expr>) WHERE __id = ANY($ids)`, theo thứ tự topo.
- Chống deadlock khi hai giao dịch tính lại chéo bảng: trước khi UPDATE, khoá dòng theo thứ tự xác định `SELECT __id FROM data.t_x WHERE __id = ANY($ids) ORDER BY __id FOR UPDATE`; các bảng được xử lý theo thứ tự topo rồi theo `db_table_name`. Deadlock vẫn xảy ra (`40P01`) → retry cả transaction tối đa 3 lần. Có integration test ghi đồng thời chéo hai bảng.
- Đồng bộ (trong transaction ghi) khi tổng số dòng bị ảnh hưởng ≤ 1.000; lớn hơn → job nền `computed.recompute` (debounce 2s, gộp theo field), UI hiển thị trạng thái "đang tính lại" trên cột.
- Cài đặt (T458, `ComputedRecomputeService` ở `server-core/computed/recompute/**` — **một cửa**: mọi nguồn gọi `enqueue(tx, changes)` trong cùng transaction với lần ghi, gồm ghi ô, ghi link hai phía, import, bulk, xoá mềm/khôi phục/purge record, đổi tên option select, đổi timezone org/field, đổi kiểu/đổi chiều link xong, tính lại `auto_number`, purge table qua `tablePurgeHooks`): dòng bị ảnh hưởng theo từng `paths` của `meta.field_dependencies`; `via_link` đi ngược junction một câu lệnh cho mỗi link và lô 10.000 id; `cross_table` có vế khoá: điều kiện dạng `CONTAIN(CurrentValue.[Link], RECORD_ID())` (lookup qua link) → qua junction, vế khoá khác → tính lại điều kiện `COUNTIF([T], c₁ || c₂ …)` chỉ trên các record nguồn đã đổi (≤ 100 record, nhiều hơn → cả bảng, job); giá trị **cũ** lấy bằng cách tìm dòng **trước** khi ghi (`before(tx, changes)`), giá trị mới sau khi ghi. Record vào/ra thùng rác, khôi phục, tạo mới → như mọi field của table đổi, cộng ô link/`parent` của record khác trỏ tới chúng; record mới/khôi phục tính mọi field computed `stored` của table. Chỉ ghi dòng có giá trị khác (`IS DISTINCT FROM`); field đọc field vừa đổi được tìm tiếp theo thứ tự topo (dòng thực sự đổi). Field vượt ngưỡng hoặc cần cả bảng → hàng đợi `meta.computed_recompute_queue` (gộp theo `(field, record)`, `'*'` = cả bảng) + job `computed.recompute` (`job_key = computed.recompute:<fieldId>`, `preserve_run_at`), `compute_state = recomputing` tới khi hàng đợi của field rỗng; job lô 5.000 dòng/transaction (`statement_timeout` 30 s), field đọc nó trong cùng lô tới 5.000 dòng nữa, còn lại vào hàng đợi của chúng; `ANALYZE` table có ≥ 10.000 dòng được ghi trong một lần chạy. Ghi record bị deadlock (`40P01`) → chạy lại cả transaction tối đa 3 lần (nghỉ ngẫu nhiên 50–150 ms). Hook `afterRecompute(tx, …)` sau khi ghi giá trị: T459 phát realtime, T509 ghi event cho automation (dưới đây; ADR-26).
- Đổi định nghĩa formula/lookup hoặc tạo mới → job backfill toàn bảng theo batch 5.000 dòng.
- Kết quả của computed field **không** sinh audit, không đổi `__version`/`__updated_*` (ADR-23 §2). Event `record.updated` (T509, ADR-26, `docs/reviews/S4b-decisions-followup.md` §3.4) chỉ được ghi — trong transaction tính lại — khi có automation `record.updated` **đang bật** của table có `watch_fields` chứa field `stored` vừa **thực sự đổi**, hoặc automation `record.matches` đang bật có điều kiện nêu field đó (T510) (không bị loop guard chặn, không `skip_bulk` với event hàng loạt), và chỉ cho record có field được theo dõi đổi: `changes` chỉ gồm field computed đổi (dạng lưu trữ), `actor = system`, `via.computed_recompute = true`. Tính lại **đồng bộ**: field computed đổi của **chính record mà lần ghi đổi** được gộp vào `changes` của event `record.updated` của lần ghi đó (không có event thứ hai — automation theo dõi cả field nguồn lẫn formula chạy một lần); record khác (qua link, chéo bảng) → event riêng mang `batch`, `via`, `causation` của lần ghi gốc (`job_id: null`; lần ghi không có causation thì `root_event_id` = event đầu của lần ghi, depth 0). Tính lại **qua job** → mọi event của một lần chạy `computed.recompute` chung `batch.id = job_…` (dẫn xuất từ id job graphile-worker, retry giữ nguyên), `via.job_id` = id đó, luôn là event hàng loạt; `causation` = gộp bảo thủ của các dòng hàng đợi (`depth` lớn nhất, `automation_chain` hợp, `root_event_id` của dòng đầu; depth **không** tăng). Giá trị đầu tiên của record vừa tạo/khôi phục (đồng bộ, hoặc dòng hàng đợi `created`) và record trong thùng rác không sinh event. Qua job, sau `AUTOMATION_MAX_RUNS_PER_BATCH` + 1 event cho một automation không có điều kiện (có điều kiện: sau khi run đại diện `skipped` đã có) thì chỉ tăng `skipped` của `meta.automation_batch_counters` (cột `events` đếm event đã ghi). Field `virtual` không theo dõi được (§11.2). Hệ quả chấp nhận: trong cửa sổ debounce, thay đổi của người dùng gộp với thay đổi do automation A có thể không kích hoạt lại A; tính lại qua job luôn là event riêng (một lần ghi lớn có thể cho hai event của cùng record: của lần ghi và của job).

### 5.10 Meta schema (tối thiểu)

Mọi bảng `meta.*` có `id text PK` dạng `<prefix>_<16 base62>` (danh sách prefix: CONTRACTS §1.2), `created_at`, `updated_at`. Ngoại lệ: bảng partition (`events`, `audit_logs`) có PK `(id, created_at)` vì PostgreSQL bắt buộc PK/unique của bảng partition chứa partition key; bảng nối thuần (`*_members`, `field_dependencies`, `computed_recompute_queue`) dùng PK ghép. Mọi bảng thuộc tenant có `organization_id` (denormalize để lọc nhanh và bắt lỗi rò tenant) — **kể cả bảng con** như `dashboard_widgets`, `automation_runs`. FK từ bảng tenant tới bảng tenant khác luôn là **FK ghép có `organization_id`** tới `UNIQUE (organization_id, id)` (hoặc `(organization_id, scope, id)`) của bảng cha; FK một cột chỉ tới bảng toàn cục. Test catalog `packages/server-core/test/db/tenant-fks.int.test.ts` (T501, đọc `pg_constraint`) khoá quy ước; ngoại lệ ghi tên trong test — hiện chỉ `form_submissions_view_fkey` (tồn: `meta.views` chưa có `UNIQUE (organization_id, id)`). Bảng toàn cục (không thuộc tenant, danh sách **đóng**): `organizations`, `users`, `user_identities`, `sessions`, `password_resets`. Chỉ các bảng này được dùng `GlobalRepository` (không nhận `organizationId`); thêm bảng vào danh sách = sửa SPEC + test. Bảng bất biến (append-only: `events`, `audit_logs`) không có `updated_at`. Ngoại lệ PK: `org_members` PK `(organization_id, user_id)`, `ai_settings` PK `organization_id`.

```sql
meta.organizations(id, name, slug UNIQUE, settings jsonb)
meta.users(id, email citext UNIQUE, display_name, avatar_url, password_hash NULL, status, locale, timezone)   -- mặc định lấy từ org
meta.user_identities(id, user_id, provider, subject, email citext NULL, last_login_at NULL, UNIQUE(provider, subject))     -- OIDC (ADR-36 §3, C§27): định danh = (provider slug, `sub`); `email` = email IdP báo lần đăng nhập gần nhất, chỉ để hiển thị (không bao giờ dùng để tìm); `email`, `last_login_at` từ migration 0050 (T707)
meta.sessions(id, user_id, token_hash UNIQUE, expires_at, ip, user_agent, last_seen_at)
meta.password_resets(id, user_id, token_hash UNIQUE, created_by NULL, source, expires_at, used_at NULL)   -- §14.2; bảng toàn cục; source: self_service | admin | cli
meta.org_members(organization_id, user_id, role, PK(organization_id, user_id))   -- owner | admin | member
meta.groups(id, organization_id, name)
meta.group_members(organization_id, group_id, user_id, PK(group_id, user_id))
meta.workspaces(id, organization_id, name, slug)
meta.workspace_members(organization_id, workspace_id, principal_type, principal_id, role, PK(workspace_id, principal_type, principal_id))  -- principal: user|group; role: admin|member
meta.bases(id, organization_id, workspace_id, owner_id, name, icon, description, settings jsonb, permission_version bigint NOT NULL DEFAULT 1, deleted_at)   -- owner_id + permission_version: §14.1
meta.base_roles(id, organization_id, base_id, name, kind, config jsonb, position)  -- kind: system_admin|system_editor|system_reader|custom (§14.1)
meta.base_role_members(organization_id, base_id, role_id, principal_type, principal_id, UNIQUE(base_id, principal_type, principal_id))
meta.tables(id, organization_id, base_id, name, description, db_table_name UNIQUE, primary_field_id, collation, schema_state, data_version bigint NOT NULL DEFAULT 0, compacted_at NULL, position, deleted_at, purged_at NULL)   -- data_version: §10.4; collation chép từ base lúc tạo, dùng cho mọi cột text của table; schema_state: ready | compacting; purged_at (T461, migration 0020): table đã bị xoá vĩnh viễn khỏi thùng rác (data table + junction đã drop; mọi tra cứu coi như không tồn tại, C§13)
meta.computed_recompute_queue(organization_id, field_id, record_id, after_auto, enqueued_at, causation jsonb NULL, created bool, PK(field_id, record_id))   -- §5.9; T458 (migration 0024): dòng của field computed `stored` chờ job `computed.recompute`; `record_id = '*'` = cả bảng (`after_auto` = vị trí job đã tới); FK ghép `(organization_id, field_id)` → `meta.fields (organization_id, id)` `ON DELETE CASCADE` (T501, migration 0026; trước đó FK một cột); `causation` gộp bằng `meta.merge_recompute_causation`, `created` = dòng chỉ tính giá trị đầu của record vừa tạo/khôi phục (T509, migration 0030)
meta.field_dependencies(organization_id, base_id, field_id, depends_on_field_id, kind, paths jsonb, created_at, PK(field_id, depends_on_field_id))   -- §5.9; T456 (migration 0022): `kind` = cách gần nhất (`same_row` < `via_link` < `cross_table`), `paths` = mọi cách đọc `[{ kind, link_path, condition_refs }]` (phụ thuộc của `analyze`) cho tính lại tăng dần (T458); FK ghép `(organization_id, field_id)` và `(organization_id, depends_on_field_id)` → `meta.fields (organization_id, id)` `ON DELETE CASCADE` (T501, migration 0026: `meta.fields` thêm `UNIQUE (organization_id, id)`; cạnh vượt tenant không thể tồn tại), field xoá mềm giữ dòng (T460 `#REF`)
meta.fields(id, organization_id, table_id, name, type, db_column_name, deleted_column_name NULL, purged_at NULL, link_table_purged_at NULL, compute_mode NULL, result_type jsonb NULL, compute_state NULL, compute_error jsonb NULL, options jsonb, is_primary, required, unique_values, description, position, deleted_at, UNIQUE(table_id, name) WHERE deleted_at IS NULL)   -- link_table_purged_at (T461, migration 0020): field link trong thùng rác vì table được liên kết đã bị purge, không khôi phục được (C§13); result_type / compute_state (`ready | backfilling | recomputing | error`) / compute_error (`{ code, refs }`) (T456, migration 0022): có đúng ở field formula/lookup cùng compute_mode (C§13); T517 (migration 0034): `type` nhận `button` (luôn `db_column_name IS NULL`)
meta.views(id, organization_id, table_id, type, name, config jsonb, position, is_personal, owner_id NULL, locked)   -- T301, C§15: tên duy nhất (không phân biệt hoa thường) trong view chung của table / view cá nhân của một owner
meta.dashboards(id, organization_id, base_id, name, icon NULL, description NULL, theme jsonb, global_filters jsonb, position, version, created_by, deleted_at NULL, deleted_by NULL)   -- T805, ADR-38 (migration 0053): FK ghép `(organization_id, base_id)` → bases ON DELETE CASCADE; tên duy nhất không phân biệt hoa thường trong base ngoài thùng rác (`dashboards_base_name_key`); index `(organization_id, base_id, position) WHERE deleted_at IS NULL`; `version` tăng mỗi thay đổi dashboard/layout/widget (C§28.1); thùng rác 30 ngày, dọn bởi `maintenance.cleanup`; không còn `layout` — layout nằm trên widget (Quyết định S7 #5)
meta.share_links(id, organization_id, base_id, table_id NULL, target_type, target_id, audience, token_prefix, token_hash UNIQUE, password_hash NULL, expires_at NULL, settings jsonb, enabled, created_by, revoked_at NULL, revoked_by NULL, last_accessed_at, access_count)  -- §15A, T304: tối đa một link chưa thu hồi / target; link thu hồi được giữ (token → 410)
meta.share_link_daily_stats(organization_id, share_link_id, day date, access_count, PK(share_link_id, day))   -- §15A.4, T304: lượt truy cập/ngày UTC, không lưu IP
meta.dashboard_widgets(id, organization_id, dashboard_id, type, title, config jsonb, layout jsonb)   -- T805, ADR-38 (migration 0053): `type` ∈ kpi|bar|line|pie|combo|table|text|filter_control (C§28.2); `layout = {x, y, w, h}` trên lưới 12 cột — nguồn layout duy nhất; FK ghép `(organization_id, dashboard_id)` → dashboards ON DELETE CASCADE, index `(organization_id, dashboard_id)`
meta.automations(id, organization_id, base_id, name, description, enabled, disabled_reason NULL, definition jsonb, trigger_type, trigger_table_id NULL, version, created_by, updated_by, run_as_user_id, run_as_since, trigger_armed_at NULL, deleted_at NULL)   -- run_as: ADR-25; T502 (migration 0027): trigger_type/trigger_table_id chép từ definition mỗi lần lưu (lọc danh sách theo table người gọi `manage`, index cho events.dispatch T503), xoá mềm `deleted_at` (luôn tắt), `updated_by` cho `409 VERSION_CONFLICT`; FK ghép `(organization_id, base_id)` → bases, `(organization_id, trigger_table_id)` → tables; CHECK: không vừa bật vừa có disabled_reason (C§21); trigger_armed_at = lúc bật gần nhất (trigger DB khi INSERT bật hoặc enabled false → true; T508, migration 0033): trigger thời gian chỉ bắn cho thời điểm sau nó; T517 (migration 0034): unique `(organization_id, definition->'trigger'->>'field_id') WHERE deleted_at IS NULL AND trigger_type = 'button.clicked'` (`automations_button_field_key`: một automation mỗi nút)
meta.automation_time_cursors(organization_id, automation_id PK, scanned_until, created_at, updated_at)   -- T508 (migration 0033): cuối cửa sổ bộ quét `schedule`/`record.date_reached` đã xử lý, khoá + dời cùng transaction với run tạo ra; FK ghép → automations ON DELETE CASCADE
meta.automation_runs(id, organization_id, automation_id, automation_version, trigger_event_id NULL, trigger_unit, status, depth, started_at, finished_at, error jsonb, input jsonb, active_ms bigint, running_since NULL, created_at, updated_at, UNIQUE(automation_id, trigger_event_id))   -- trigger_unit: batch id hoặc root_event_id (ADR-26); status queued|running|waiting|succeeded|failed|skipped|cancelled; FK ghép → automations ON DELETE CASCADE; trigger_event_id không FK (events partition); active_ms = thời gian đã chạy của các đoạn đã kết thúc, running_since = đầu đoạn đang chạy (0031, T505, §11.7); rerun_of_run_id NULL + rerun_by_user_id NULL (0032, T518): run chạy lại trỏ về run gốc — FK ghép `(organization_id, rerun_of_run_id)` → automation_runs ON DELETE SET NULL (rerun_of_run_id), rerun_by → users; dọn sau `AUTOMATION_RUN_RETENTION_DAYS` (cron `automation.runs_cleanup`, steps CASCADE); trigger_key NULL + UNIQUE(automation_id, trigger_key) = khoá dedupe của run trigger thời gian (`automation_id:fired_at`, `automation_id:record_id:<giá trị>`; 0033, T508); index một phần `automation_runs_trigger_event_idx (organization_id, trigger_event_id) WHERE trigger_event_id IS NOT NULL` (0048, T616 — lọc run theo `event_id`, C§21)
meta.automation_batch_counters(organization_id, automation_id, batch_id, runs, skipped, events, created_at, PK(automation_id, batch_id))   -- trần fan-out mỗi lô (ADR-26), dọn sau 24h; FK ghép → automations; `events` = event tính lại một lần chạy `computed.recompute` đã ghi cho automation (T509, migration 0030)
meta.automation_run_steps(id, organization_id, run_id, action_id, status, attempt, idempotency_key UNIQUE, started_at, finished_at, input jsonb, output jsonb, error jsonb)   -- status running|waiting|succeeded|failed|skipped|cancelled; FK ghép → automation_runs ON DELETE CASCADE
meta.events(id text, organization_id, type, entity_type, entity_id, actor_type, actor_id, payload jsonb, causation jsonb, created_at, dispatched_at NULL, PK(id, created_at))  -- partition theo tháng; dispatched_at do events.dispatch đặt; index (organization_id, created_at), (created_at) WHERE dispatched_at IS NULL, (organization_id, entity_id, created_at) — migration 0037, T528: các thay đổi sau của một record cho `record.matches`
meta.audit_logs(id, organization_id NULL, base_id NULL, table_id NULL, actor_type, actor_id, via jsonb NULL, action, entity_type, entity_id, batch_id NULL, request_id NULL, before jsonb, after jsonb, ip, user_agent, created_at, PK(id, created_at))  -- partition theo tháng, append-only (ADR-23); index `(organization_id, actor_id, created_at DESC, id DESC)`, `(organization_id, action, created_at DESC, id DESC)` trên bảng cha — migration 0052, T709 (C§11.4)
meta.api_tokens(id 'tok_', organization_id, user_id, name, token_prefix, token_hash bytea UNIQUE, scopes text[], base_ids text[] NULL, expires_at NULL, last_used_at NULL, revoked_at NULL, revoked_by NULL, UNIQUE(organization_id, id))   -- T703 (migration 0049), ADR-36 §1, C§26: token cá nhân của một thành viên trong một org; `token_hash` = SHA-256 (32 byte) của cả token `cht_…` — token không bao giờ được lưu; `token_prefix` = 8 ký tự sau `cht_`; `scopes` ⊆ danh sách đóng C§26.2 (CHECK, ≥ 1); `base_ids` NULL = mọi base của chủ, không thì 1–50 base; thu hồi mềm (`revoked_at`, `revoked_by`); token thu hồi/hết hạn giữ 90 ngày rồi cron `maintenance.cleanup` xoá; `last_used_at` do T704 ghi; FK ghép `(organization_id, user_id)` → `org_members` `ON DELETE CASCADE` (rời org = mất token), `(organization_id, revoked_by)` → `org_members` `SET NULL (revoked_by)`; index một phần `(organization_id, user_id) WHERE revoked_at IS NULL` (trần 50 token chưa thu hồi); tra theo hash chỉ qua `findApiTokenByHash` (§14.1)
meta.incoming_webhooks(id, organization_id, base_id, name, token_hash UNIQUE, token_enc, auth, signing_secret_enc NULL, signing_secret_prev_enc NULL, signing_secret_prev_expires_at NULL, bearer_hash NULL, rate_limit_per_sec, listen_until NULL, listened_by NULL, sample jsonb NULL, sample_captured_at NULL, enabled, created_by NULL, created_at, updated_at, deleted_at NULL, UNIQUE(organization_id, id))   -- §13.2, T602 (migration 0043), ADR-35 §1: chỉ base admin quản lý (C§25.1); `auth` ∈ signature|bearer|both|none luôn khớp credential (CHECK); `token_enc`/`signing_secret_*_enc` AES-256-GCM (HKDF `incoming-webhook:v1`, `incoming-webhook-signing:v1`), `bearer_hash` SHA-256; tên duy nhất trong base (không phân biệt hoa thường, hook chưa xoá); ≤ 50 hook chưa xoá mỗi base; bỏ cột `target` (automation trỏ tới hook); FK ghép `(organization_id, base_id)` → `bases` CASCADE, `(organization_id, created_by|listened_by)` → `org_members` SET NULL (cột)
meta.incoming_webhook_requests(id, organization_id, incoming_webhook_id, message_id NULL, received_at, body jsonb NULL, headers jsonb, query jsonb, size_bytes, duplicate, causation_accepted, event_id NULL, UNIQUE(organization_id, id), UNIQUE(organization_id, incoming_webhook_id, message_id))   -- T602 (migration 0043), ADR-35 §1: request thô giữ 7 ngày (cron `maintenance.cleanup`), dedupe `webhook-id` theo hook (`NULL` = không dedupe), `duplicate` chỉ ghi nhận request trùng (không body/event); FK ghép `(organization_id, incoming_webhook_id)` → `incoming_webhooks` CASCADE; index `(organization_id, incoming_webhook_id, received_at DESC, id DESC)` và `(received_at)` (dọn 7 ngày)
meta.attachments(id, organization_id, base_id, table_id, record_id NULL, field_id, object_key, filename, mime, size, sha256 NULL, status, created_by NULL, detached_at NULL, thumbnail_status NULL, thumbnail_started_at NULL)   -- T406 (migration 0012), T407 (migration 0016: `thumbnail_status` pending | running | ready | skipped | failed, chung cho mọi dòng cùng `object_key`): 1 dòng/tệp/record, bản sao sang record khác = dòng mới chung `object_key` (S4 #12); `record_id` NULL = upload chưa gắn ô; status `pending_upload | ready | pending_scan`; `detached_at` = đã gỡ khỏi ô (giữ 30 ngày cho undo/revert); `record_purged_at` (T408, migration 0017) = record đã bị xoá vĩnh viễn; `share_link_id` + `upload_session` (T410, migration 0018) = upload qua link form, gắn với submit token (C§17); cron `attachments.cleanup` (C§20)
meta.form_covers(id, organization_id, base_id, table_id, view_id, object_key, filename, mime, size, sha256 NULL, status, created_by NULL)   -- T419 (migration 0019): ảnh bìa form (`config.form.cover_attachment_id`), không phải giá trị ô; status `pending_upload | ready`; chỉ png/jpeg/gif/webp ≤ 5 MB; ảnh không view form nào trỏ tới bị `attachments.cleanup` xoá sau 24h (C§17)
meta.secrets(id, organization_id, kind, name, ciphertext, previous_ciphertext NULL, previous_expires_at NULL, allowed_hosts text[], legacy_hosts_until NULL, base_scope, created_by NULL, UNIQUE(organization_id, id), UNIQUE(organization_id, lower(name)))   -- T516 (migration 0036): secret cấp org do org owner/admin quản lý (C§24); `kind` = `telegram_bot` (token bot của `send_telegram`), `http_header` (giá trị header auth của `http_request`), `webhook_signing` (`whsec_…` ký Standard Webhooks) — hai kind sau và cột xoay từ T606 (migration 0047): `previous_ciphertext` = giá trị cũ của `webhook_signing` vừa đổi (cùng khoá), còn ký tới `previous_expires_at` (24 h), cả hai cùng `NULL` hoặc cùng có, chỉ trên `webhook_signing`; `ciphertext` = AES-256-GCM, khoá HKDF từ `APP_MASTER_KEY` (`info = org-secret:v1`), không bao giờ trả về/log/audit; `base_scope` all | selected như danh tính gửi (ADR-33); `allowed_hosts` (T701, migration 0051, ADR-36 §4) = pattern host chuẩn (như `http_allowlist.pattern`, 1–20 mục) secret `http_header`/`webhook_signing` được gửi tới — kiểm lúc lưu (URL literal) và lúc gửi (trước giải mã, trước DNS/kết nối; không mở địa chỉ private); `legacy_hosts_until` = hạn chuyển đổi 30 ngày của secret HTTP có trước migration (danh sách rỗng: gửi mọi host tới hạn, sau đó `secret_host_not_allowed` `legacy_expired`); CHECK: secret HTTP có đúng một trong hai, kind khác không có cái nào
meta.secret_bases(organization_id, secret_id, base_id, PK(secret_id, base_id))   -- T516: base của phạm vi `selected`; FK ghép `(organization_id, secret_id)` → secrets, `(organization_id, base_id)` → bases, `ON DELETE CASCADE`
meta.email_identities(id, organization_id, email, display_name, reply_to NULL, transport, mode, status, status_before_disable NULL, error_reason NULL, verified_at NULL, verified_via NULL, base_scope, signature_md NULL, smtp_host NULL, smtp_port NULL, smtp_security NULL, smtp_username NULL, smtp_password_enc NULL, smtp_version, auth_failures, created_by NULL, UNIQUE(organization_id, id), UNIQUE(organization_id, email))   -- T530 (migration 0029), ADR-33: danh tính gửi email; `transport` system | smtp (cột `smtp_*` có đủ khi và chỉ khi `smtp`, cổng 25/465/587/2525); `mode` send_as | on_behalf (smtp luôn send_as); `status` pending | verified | error | disabled (`status_before_disable` = trạng thái để `enable` trả về); `smtp_password_enc` = mật khẩu AES-256-GCM, khoá HKDF từ `APP_MASTER_KEY` (`info` riêng), không bao giờ trả về/log/audit; `smtp_version` tăng khi đổi endpoint/credentials (transport cache dựng lại); `auth_failures` = lỗi xác thực liên tiếp khi gửi (3 → `error`); email chữ thường (C§23.3)
meta.email_identity_bases(organization_id, identity_id, base_id, PK(identity_id, base_id))   -- T530: base của phạm vi `selected`; FK ghép `(organization_id, identity_id)` → email_identities, `(organization_id, base_id)` → bases, `ON DELETE CASCADE`
meta.email_identity_verifications(identity_id PK, organization_id, email, token_hash, code_hash, failed_attempts, requested_by NULL, expires_at, UNIQUE(organization_id, token_hash))   -- T530: lần xác minh còn hiệu lực duy nhất của một danh tính (gửi lại = thay); token `<org_id>.<secret>` lưu SHA-256 phần bí mật, mã 6 số lưu HMAC, 24 giờ, ≤ 5 lần sai; FK ghép `(organization_id, identity_id)` `ON DELETE CASCADE`; PK một cột `identity_id` (bảng 1-1 với danh tính)
meta.email_assets(id, organization_id, kind, automation_id NULL, object_key, filename, mime, size, width NULL, height NULL, sha256 NULL, status, created_by NULL)   -- T534 (migration 0035): ảnh upload cho thư automation (`kind` `signature` = chữ ký org/danh tính, org owner/admin; `automation` = thân thư của một automation, người quản lý automation), không phải giá trị ô; status `pending_upload` → `ready` (đã kiểm nội dung, xoay theo EXIF, bỏ metadata, ≤ 1280 px, ≤ 2 MiB; `mime`/`size`/`width`/`height` là của ảnh đã xử lý); Markdown tham chiếu `asset:<id>`; FK ghép `(organization_id, automation_id)` `ON DELETE SET NULL (automation_id)` (object không bị bỏ rơi); cron `attachments.cleanup` xoá ảnh không chữ ký/automation nào tham chiếu sau 24 giờ
meta.http_allowlist(id, organization_id, pattern, host, wildcard, port NULL, note, created_by NULL, UNIQUE(organization_id, id), UNIQUE(organization_id, pattern))   -- T600 (migration 0042), ADR-35 §3: host automation được gọi trong mạng nội bộ (vd n8n), org owner/admin quản lý (C§25.4); `pattern` dạng chuẩn (chữ thường, punycode) = host chính xác hoặc `*.hậu_tố` (≥ 2 nhãn) + `:cổng` tuỳ chọn, không IP/CIDR; `host`/`wildcard`/`port` là các phần của nó (`port` NULL = cổng 80/443); ≤ 100 mục/org; FK ghép `(organization_id, created_by)` → org_members `ON DELETE SET NULL (created_by)`
meta.http_deliveries(id 'hdl_', organization_id, kind action|test, automation_id NULL, run_id NULL, action_id NULL, requested_by NULL, idempotency_key, message_id, method, target_host, request_enc NULL, auth_secret_id NULL, signing_secret_id NULL, status pending|sending|succeeded|failed|cancelled, attempts, next_attempt_at, lease_until NULL, last_status NULL, last_error jsonb NULL, response jsonb NULL, created_at, completed_at NULL, UNIQUE(organization_id, id), UNIQUE(organization_id, idempotency_key))   -- T605 (migration 0044), ADR-35 §4, C§25.5: outbox của HTTP ra; `request_enc` (URL, header không bí mật, body, causation — AES-256-GCM HKDF `http-delivery:v1`) rỗng đúng khi trạng thái cuối (CHECK); `message_id` = `webhook-id` = id dòng; `target_host` là phần duy nhất của URL để rõ; FK ghép `(organization_id, run_id)` → automation_runs và `(organization_id, automation_id)` → automations `CASCADE`, `(organization_id, requested_by)` → org_members và `(organization_id, auth_secret_id|signing_secret_id)` → secrets `SET NULL (cột)`; index một phần `(next_attempt_at) WHERE status IN ('pending','sending')`; dòng `action` theo thời hạn run (T518), dòng `test` xoá sau 24 giờ
meta.ai_settings(organization_id, provider_base_url, model, api_key_secret_id, allow_record_data bool, enabled)
meta.invitations(id, organization_id, email citext, inviter_id, org_role, workspace_id NULL, token_hash UNIQUE, expires_at, accepted_at NULL, revoked_at NULL)   -- T008, hết hạn 7 ngày
meta.jobs(id, organization_id, type, status, progress real, result jsonb NULL, error jsonb NULL, created_by, created_at, finished_at NULL)   -- trạng thái job nền cho `GET /jobs/:id` (C§1.1); graphile-worker xoá job khi xong nên cần bảng riêng; dọn sau 30 ngày
meta.field_conversions(job_id PK, organization_id, table_id, field_id, status running|succeeded|failed|reverted|cleaned, from_definition jsonb, to_definition jsonb, old_column_name NULL, new_column_name, shadow_column_name, context jsonb, max_auto, cursor_auto, counts jsonb, created_by, expires_at, finished_at, reverted_at, cleaned_at, kind column|to_two_way|to_one_way|to_single, partner_table_id NULL, partner_field_id NULL, backup_table_name NULL)   -- T403: mỗi lần đổi kiểu field (§5.5), migration 0013; T404 (migration 0015): đổi link — không cột (new/shadow NULL), phía kia bị khoá schema khi chạy, `to_single` giữ liên kết đã gỡ trong `data.l_x__old_<ms>` 7 ngày
meta.imports(id, organization_id, base_id, created_by, filename, format, size, options jsonb, job_id NULL UNIQUE, expires_at)   -- T308: file upload tạm để import CSV/XLSX (object `{org}/{imp_…}`), tuỳ chọn của preview gần nhất, job đã dùng; cron `imports.cleanup` xoá sau 24h
meta.idempotency_keys(organization_id, principal_key, key, request_hash, status_code, response jsonb, created_at, PK(principal_key, key))   -- `Idempotency-Key` (C§1.1) và `webhook-id` chống replay (C§10); dọn sau 24h
meta.notifications(id 'ntf_', organization_id, user_id, type, base_id NULL, table_id NULL, entity_type, entity_id, actor_type NULL, actor_id NULL, group_key NULL, payload jsonb, in_app bool, read_at NULL, created_at)   -- ADR-29 §1, T511 (migration 0028): một dòng mỗi người nhận; payload chỉ id + tham số dạng lưu trữ, ngoại lệ nội dung đã render của `automation.message` (ADR-32 §1); `in_app = false` = người nhận tắt in-app, dòng chỉ còn cho kênh email; UNIQUE (organization_id, user_id, type, group_key) khi `group_key` có (idempotency của bên phát); FK ghép `(organization_id, user_id)` → `org_members` (rời org thì xoá), `(organization_id, base_id)` → `bases`, `(organization_id, table_id)` → `tables` (CASCADE); dọn sau `NOTIFICATION_RETENTION_DAYS` (cron `notifications.cleanup`)
meta.notification_deliveries(organization_id, notification_id, channel, status, attempts, error_code NULL, created_at, sent_at NULL, PK(notification_id, channel))   -- T511: outbox kênh ngoài in-app (`email`; `telegram` từ migration 0040, gửi bởi T550), `pending` = đã xếp gửi, T512 (email) / T550 (Telegram) gửi/gom/đánh dấu (`sent|skipped|failed`, `error_code` = lý do bỏ hoặc mã lỗi email/Telegram — C§22.4; `attempts` đếm lần gửi lỗi tạm thời, thứ 5 → `failed`); FK ghép tới `notifications` CASCADE
meta.notification_preferences(organization_id, user_id, type, channel, enabled, updated_at, PK(organization_id, user_id, type, channel))   -- ADR-29 §1, T511: không có dòng = mặc định của type (C§22); `channel`: `in_app|email|telegram` (`telegram` từ migration 0040, T549)
meta.notification_settings(organization_id, user_id, email_frequency, daily_hour, auto_follow_created bool, auto_follow_assigned bool, updated_at, PK(organization_id, user_id))   -- ADR-32 §1, T511: `immediate|daily|off` (mặc định `immediate`), giờ digest 0–23 theo timezone người dùng (mặc định 8); T543 (migration 0039): công tắc tự theo dõi record tạo bằng tay / được gán (mặc định `true`, C§22.5)
meta.notification_base_mutes(organization_id, user_id, base_id, created_at, PK(organization_id, user_id, base_id))   -- ADR-32 §1, T511: base tắt tiếng (không email/Telegram, in-app vẫn ghi; không áp loại bắt buộc)
meta.notification_buffer(id bigint identity, organization_id, kind, group_key, user_id NULL, table_id, record_id, field_ids text[], actor_type NULL, actor_id NULL, created_at, PK(organization_id, id))   -- ADR-34 §2, T542 (migration 0038): hàng chờ gom của ghi hàng loạt — `kind` `assigned` (`group_key = <batch.id>:<table_id>` — T544, `user_id` = người được gán) | `followed` (`group_key` = record id, `user_id` NULL: người nhận tính lúc xả); ghi cùng transaction với `events.dispatch` + job `notifications.flush` (`job_key = <kind>:<group_key>`), xoá trong transaction xả, và trong transaction purge table (dòng `meta.tables` ở lại với `purged_at` nên FK không cascade — T560); FK ghép `(organization_id, user_id)` → `org_members`, `(organization_id, table_id)` → `tables` (CASCADE); index `(organization_id, kind, group_key)`, `(created_at)` (cron `notifications.cleanup` xả lại nhóm có hàng > 10 phút)
meta.record_follows(organization_id, table_id, record_id, user_id, source, muted bool, created_at, updated_at, PK(organization_id, table_id, record_id, user_id))   -- ADR-34 §2, T543 (migration 0039): người theo dõi record — `source` `manual|created|assigned` (S11 thêm `commented`); `muted = true` = đã bỏ theo dõi thủ công, giữ dòng để nguồn tự động không theo dõi lại (C§22.5); không FK tới record (`data.*`): purge record/table xoá dòng trong transaction purge; FK ghép `(organization_id, user_id)` → `org_members`, `(organization_id, table_id)` → `tables` (CASCADE); index `(organization_id, user_id)` (trần 10.000 theo dõi mỗi người mỗi org, không tính `muted`)
meta.date_reminder_cursors(organization_id, field_id, armed_at, scanned_until, boundary_due_at NULL, boundary_record_ids text[], created_at, updated_at, PK(organization_id, field_id))   -- ADR-34 §1, T547 (migration 0041): con trỏ của nhắc hạn theo field `datetime` — dòng tồn tại **đúng khi** `options.reminder` bật (`SchemaService` ghi/xoá cùng transaction với thay đổi field: bật/đổi/khôi phục → `armed_at = now`; tắt, vào thùng rác, đổi kiểu, purge table → xoá); `scanned_until` dời trong transaction quét đã enqueue nhắc; `boundary_*` = keyset của lần quét chạm trần 1.000: thời điểm tới hạn nó dừng ở đó + record **cuối cùng** đã nhắc (`boundary_record_ids` một phần tử từ T560 — quét theo `(giá trị, __id)` nên mọi record của thời điểm đó tới record này đã xử lý; lần sau lõi nhảy qua bằng một dòng dò thay vì đọc lại cả thời điểm — QA S5b M7; dòng ghi trước T560 có nhiều id, phần tử cuối là cùng keyset; quét hết cửa sổ thì xoá); FK ghép `(organization_id, field_id)` → `fields` (CASCADE); PK phục vụ keyset của `listDateReminderFields` (C§22.6)
meta.user_channels(id 'uch_', organization_id, user_id, kind, secret_id NULL, address_enc, address_hmac, status, error_reason NULL, linked_at, created_at, updated_at, UNIQUE(organization_id, id), UNIQUE(organization_id, user_id, kind))   -- ADR-34 §3, T549 (migration 0040): kênh thông báo cá nhân (`kind` = `telegram`); `secret_id` = bot thông báo đã liên kết qua; `address_enc` = chat id mã hoá AES-256-GCM (HKDF `user-channel:v1`), `address_hmac` = HMAC tra cứu theo bot + chat (`user-channel-lookup:v1`, cho `/stop`) — không bao giờ trả về API/log/audit; `status` `linked|error` + `error_reason` `bot_changed|blocked`; FK ghép `(organization_id, user_id)` → `org_members` (CASCADE), `(organization_id, secret_id)` → `secrets` (`SET NULL (secret_id)`); index `(organization_id, secret_id, address_hmac)` (C§22.7)
meta.telegram_webhooks(organization_id PK, secret_id, path_token_hash UNIQUE, secret_token_enc, registered_url, status ok|error, last_error_code NULL, last_checked_at NULL, created_at, updated_at)   -- ADR-35 §7, T609 (migration 0046): webhook của bot thông báo ở chế độ `webhook`, tối đa một dòng mỗi org; chỉ lưu `sha256` của path token, `secret_token` mã hoá (HKDF `telegram-webhook:v1`), `registered_url` là tiền tố `PUBLIC_URL/api/v1/telegram/webhook/` **không** kèm path token; `last_error_code` ∈ `delivery_failed` | `webhook_conflict` | `invalid_token` (không lưu chữ lỗi của Telegram); FK ghép → `secrets` (CASCADE); không nằm trong `meta.secrets` (C§22.7)
meta.user_channel_link_tokens(organization_id, token_hash, user_id, kind, secret_id, expires_at, used_at NULL, created_at, PK(organization_id, token_hash))   -- ADR-34 §3, T549 (migration 0040): token liên kết `/start` một lần, chỉ lưu `sha256` (hex); chờ = chưa dùng/huỷ (`used_at`) và chưa hết hạn (10 phút); giữ ≥ 1 giờ để đếm trần 5 lần tạo/giờ; FK ghép → `org_members`, `secrets` (CASCADE); index `(organization_id, user_id, created_at)` và chờ `(expires_at, organization_id, secret_id) WHERE used_at IS NULL`. CHECK kênh của `notification_preferences` (`in_app|email|telegram`) và `notification_deliveries` (`email|telegram`) đổi ở cùng migration (C§22.7)
```

Bảng của các sprint sau, định nghĩa trong ADR-29 (S5b: chi tiết ở ADR-34) và chỉ tạo khi làm sprint đó: (S5b đã tạo đủ: `notifications`, `notification_preferences` ở S5 — T511, `notification_buffer` ở T542, `record_follows` ở T543, `user_channels`, `user_channel_link_tokens` ở T549, `date_reminder_cursors` ở T547); `approval_flows`, `approval_instances`, `approval_tasks`, `approval_ccs` (S10); `record_comments`, `comment_reactions` (S11).


Agent được phép thêm cột/bảng phụ khi cần, nhưng phải ghi trong phần "Database migration" của báo cáo task.

---

## 6. Filter DSL (dùng chung toàn hệ thống)

### 6.1 Cấu trúc

```json
{
  "op": "and",
  "items": [
    { "field": "fld_status", "operator": "is", "value": "opt_done" },
    { "op": "or", "items": [
      { "field": "fld_amount", "operator": "gt", "value": 1000000 },
      { "field": "fld_owner", "operator": "has_any_of", "value": [{ "$var": "current_user" }] }
    ]}
  ]
}
```

- Node nhóm: `{ "op": "and" | "or", "items": [...] }`, `{ "op": "not", "item": {...} }`. Độ sâu tối đa 5, tối đa 50 điều kiện.
- Field luôn tham chiếu **field id**, không bao giờ tên.
- Chi tiết cài đặt (chốt khi làm T104):
  - Mọi toán hạng ngày tính theo timezone của ngữ cảnh (org/user), không theo `options.timezone` của field. `days_ago N` / `days_from_now N` là **đúng ngày thứ N** (khoảng 1 ngày), không phải "trong N ngày". Tuần bắt đầu thứ Hai. Ngày được resolve thành khoảng nửa mở `[start, end)`.
  - `current_user_groups` = danh sách user id của **mọi thành viên** trong các group mà người dùng hiện tại thuộc về (dùng với field user: "việc của nhóm tôi").
  - Không có người dùng (share link, hệ thống): `current_user` bị bỏ khỏi danh sách; `has_any_of []` không khớp record nào.
  - Mọi điều kiện chỉ trả đúng/sai (không có NULL); operator phủ định là phần bù chính xác của operator khẳng định, nên ô rỗng khớp `neq`/`not_contains`/`has_none_of`. Ô rỗng: text `NULL` hoặc `''`, mảng `NULL` hoặc `{}`. `eq`/`neq` trên text cũng so khớp không dấu, không phân biệt hoa thường như `contains`. Danh sách rỗng sau khi resolve: `has_any_of`/`has_all_of`/`is_exactly`/`is_any_of` → sai, `has_none_of`/`is_none_of` → đúng (không bao giờ nới quyền). Số so sánh như thập phân chính xác.
  - Mỗi nhóm `and`/`or`/`not` tính 1 cấp độ sâu. Chuỗi rỗng không phải giá trị lọc hợp lệ (dùng `is_empty`).
- Biến: `current_user`, `current_user_groups` (user id của mọi thành viên trong các group của user hiện tại, xem chi tiết bên dưới), `today`, `now`, ngày cụ thể `{ "$date": { "exact": "2026-09-25" } }` hoặc `{ "$date": { "exact": "2026-09-25T09:30" } }` (hiểu theo timezone org/user), và relative date `{ "$date": { "relative": "days_ago", "amount": 7 } }` (`today`, `tomorrow`, `yesterday`, `days_ago`, `days_from_now`, `this_week`, `this_month`, `last_month`, `this_year`). Tính theo timezone của org/user.

### 6.2 Operator theo loại field

| Nhóm field | Operators |
|---|---|
| text (mọi style), auto_number | `eq`, `neq`, `contains`, `not_contains`, `starts_with`, `ends_with`, `is_empty`, `is_not_empty` (contains/starts/ends so khớp **không dấu, không phân biệt hoa thường**) |
| number (mọi style), formula/lookup kết quả số | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `is_empty`, `is_not_empty` |
| datetime, created_at, updated_at | `is` (cùng ngày), `before`, `after`, `on_or_before`, `on_or_after`, `between`, `is_empty`, `is_not_empty` |
| checkbox | `is` |
| select (`multiple=false`) | `is`, `is_not`, `is_any_of`, `is_none_of`, `is_empty`, `is_not_empty` |
| select (`multiple=true`), user, created_by, updated_by, link, attachment (chỉ is_empty/is_not_empty), lookup dạng list | `has_any_of`, `has_all_of`, `has_none_of`, `is_exactly` (tập bằng nhau), `is_empty`, `is_not_empty` |

Link (T402): giá trị là record id, so trên tập record đích **còn sống** của ô (như khi đọc), SQL là subquery trên junction; dùng trong filter của request, view và (T710) record rule của role — `edit_filter`/`read_filter` (C§2, C§14): chỉ theo id, không `$var`, không toán tử text/tiêu đề.

Lookup `where` (§5.8) có thêm `intersects`, `disjoint` và giá trị `{ "field_ref": "fld_x" }`. Formula/lookup dùng operator theo **kiểu kết quả** của nó.

Chỉ riêng trong automation condition có thêm: `changed`, `changed_to`, `changed_from` (xem §11.3).

### 6.3 Hai cài đặt

- `compileToSql(ast, tableMeta, ctx): Kysely Expression` — **chỉ** chỗ này sinh WHERE cho record query. Giá trị luôn là parameter.
- `evaluate(ast, record, ctx): boolean` — in-memory, dùng cho automation condition và kiểm tra record rule sau khi update.

Bắt buộc có **test tương đương**: với cùng bộ dữ liệu fixture, kết quả `compileToSql` chạy trên Postgres phải khớp `evaluate` cho mọi operator.

---

## 7. Query engine

Mọi đọc/ghi record **MUST** đi qua `RecordQueryService` / `RecordMutationService` trong `server-core`. Không module nào khác được truy vấn trực tiếp `data.*`.

### 7.1 Request đọc

```json
{
  "table_id": "tbl_x",
  "view_id": "viw_x",
  "fields": ["fld_a", "fld_b"],
  "filter": { "op": "and", "items": [] },
  "sort": [{ "field": "fld_a", "direction": "asc" }],
  "search": "nguyen van",
  "offset": 0,
  "limit": 200
}
```

- `view_id` (nếu có): filter/sort của view được AND/ưu tiên trước filter/sort của request.
- `limit` tối đa 1000 (API) / 500 (grid window).
- Trả về `records`, `total` (đếm chính xác khi ≤ 100.000, nếu lớn hơn trả `total_estimate`).
- Rủi ro đã biết: phân trang offset sâu (vd `offset=199800` với sort tuỳ ý) phải quét qua mọi dòng trước đó. T106 đo riêng p95 ở offset sâu; nếu không đạt mục tiêu §21 → thêm ADR cho keyset cursor (`sort values + __auto`) dành cho grid, giữ offset cho API công khai. `work_mem` (T319): transaction đọc giữ mặc định của PostgreSQL (không `SET LOCAL work_mem`) — đo T106 trên 200k qua view (filter + sort + group 2 cấp) với 4/16/32/64 MB không thấy cải thiện ổn định ở offset giữa/cuối (p95 cuối: 308 ms mặc định, 425–566 ms với 16–32 MB, dao động giữa các lần chạy lớn hơn khác biệt); xét lại cùng keyset cursor nếu p95 offset sâu vượt §21.

### 7.2 Pipeline

```text
resolve principal
 → table access check (read)
 → xác định visible fields (field permissions) ∩ requested fields
 → build WHERE = view filter AND request filter AND record rules(read) AND __deleted_at IS NULL
 → validate mọi field trong filter/sort đều visible với principal (không cho filter theo field bị ẩn)
 → build SELECT (computed `virtual` = biểu thức SQL chèn trực tiếp; link = array_agg qua junction) + ORDER BY (+ __auto làm tie-breaker)
 → execute (statement_timeout 10s)
 → serialize theo field-types
```

Nhất quán meta ↔ bảng vật lý khi đọc: đọc chạy trong transaction `REPEATABLE READ` chỉ đọc, câu lệnh **đầu tiên** là `LOCK TABLE data.<t> IN ACCESS SHARE MODE` (chưa lấy snapshot). PostgreSQL phân giải cột theo catalog mới nhất chứ không theo snapshot, nên nếu snapshot lấy trước khi một DDL của `SchemaService` commit thì meta cũ + bảng mới lệch nhau (cột đã đổi tên `__deleted_` → `42703`; bảng vừa compaction → không thấy dòng nào). DDL giữ `ACCESS EXCLUSIVE` tới khi commit, nên lấy khoá trước rồi mới lấy snapshot đảm bảo meta và bảng cùng một thời điểm. Ghi đã nhất quán nhờ advisory lock shared theo table (`READ COMMITTED`, khoá trước câu lệnh đầu tiên).

### 7.3 Ghi

`create / update / delete / bulk` trong **một transaction**:
1. Kiểm tra quyền table + field (edit) + record rule (update/delete: record phải khớp rule **trước** khi sửa; sau khi sửa vẫn phải khớp, nếu không → 403).
2. Validate giá trị theo field type (zod từ `field-types`), required, unique.
3. Nếu body có `version` (C§1.4) → optimistic check; lệch → `409 VERSION_CONFLICT`. Không dùng header `If-Match`.
4. Ghi dòng, tăng `__version`, cập nhật link junction.
5. Tính lại computed field bị ảnh hưởng (§5.9): đồng bộ nếu ≤ 1.000 dòng, còn lại enqueue `computed.recompute`.
6. Ghi `meta.events` + `meta.audit_logs` + enqueue job `events.dispatch` (graphile-worker `add_job` trong cùng transaction).
7. Commit → publish realtime (sau commit).

Bulk tối đa 1.000 record/request.

### 7.4 Tìm kiếm

`search` khớp `meta.f_unaccent(lower(primary_field)) LIKE '%' || meta.f_unaccent(lower($q)) || '%'` dùng GIN trigram index. Tìm toàn bộ field text: Phase 2.

---

## 8. Views

`meta.views.config` (zod schema trong contracts):

```json
{
  "filter": { "op": "and", "items": [] },
  "sort": [],
  "group": [{ "field": "fld_status", "direction": "asc" }],
  "hidden_fields": ["fld_x"],
  "field_order": ["fld_a", "fld_b"],
  "column_widths": { "fld_a": 220 },
  "frozen_count": 1,
  "row_height": "short",
  "tree": { "enabled": false, "show_ancestors": true },
  "color_rules": [{ "id": "clr_…", "enabled": true, "filter": { "op": "and", "items": [] }, "color": "red", "target": "row", "field_id": null }],
  "kanban": { "group_field": "fld_status", "card_fields": ["fld_a"], "cover_field": null, "hide_empty_columns": false },
  "form": { "title": "", "description": "", "cover_attachment_id": null, "fields": [{ "field": "fld_a", "required": true, "label": null, "help": null }], "success_message": "", "redirect_url": null, "allow_multiple_submissions": true, "require_login": false, "submission_limit": "none" }
}
```

### MVP
- **Grid**: glide-data-grid, windowed loading 200 dòng/lần, inline edit, resize, freeze, hide/reorder field, sort, filter, group (tối đa 3 cấp, group xử lý ở server bằng ORDER BY + header ảo ở client), chọn nhiều dòng, copy/paste (TSV) nhiều ô, fill-down, xoá nhiều, expand record (modal chi tiết, field link hiển thị dạng bảng con nhúng §5.6), hiển thị dạng cây khi bật sub-records (§5.7).
- **Kanban**: group theo `select` đơn chọn (hoặc `user` đơn), kéo thả = update field, cột "Chưa phân loại" cho giá trị rỗng.
- **Form**: chia sẻ qua share link (§15A, `audience` = `org` hoặc `public`) hoặc chỉ thành viên base; validate theo field type; chống spam không dùng dịch vụ ngoài (submit token ký có thời gian điền tối thiểu, honeypot, rate limit theo IP 10/phút; ADR-0030); tuỳ chọn yêu cầu đăng nhập và giới hạn nộp theo người (`once`/`daily`/`weekly`/`monthly`, theo timezone base); điền sẵn qua URL; sinh event `form.submitted` (CONTRACTS §17).

**Tô màu dòng/ô (S7, T816, Quyết định S7 #21)**: view grid có `color_rules` (≤ 20, thứ tự = ưu tiên; mỗi rule một filter DSL, một token trong bảng 10 màu, `target` dòng hoặc ô của một field). Server đánh giá trong cùng câu `records/query` và trả `record.meta.color` (id rule thắng của dòng và của từng ô) — client không đánh giá filter. Rule nêu field người xem không đọc được bị bỏ qua cho người đó (không tô, không lỗi: màu theo field ẩn là oracle); qua share link chỉ rule mà mọi field trong phạm vi link; realtime tính lại màu theo quyền từng subscriber. Lưới vẽ nền + vạch trái (không chỉ dựa vào màu). Chi tiết: CONTRACTS §1.4, §7, §15, §16A.

View cá nhân (`is_personal`) chỉ owner thấy; ai đọc được table là tạo được, không chịu `visible_views`, config chỉ dùng field owner đọc được. Sửa view chung cần `view_rule.allow_edit` (§14.1) hoặc quyền schema của table. View chung khoá được (`locked`, chỉ người có quyền schema của table): khi khoá không ai đổi được config. Table luôn còn ít nhất một view chung; tối đa 200 view/table và 50 view cá nhân/user/table. API, validate config, field đã xoá: CONTRACTS §15.

Phase 2: Calendar, Gallery, Gantt.

---

## 9. Formula engine (`packages/formula-engine`)

### 9.1 Mục tiêu
Cú pháp **tương thích với công thức Lark Base** (người dùng chuyển sang có thể dán lại công thức cũ với thay đổi tối thiểu) và mạnh ngang Lark: tham chiếu cùng dòng, qua link, và truy vấn cả bảng khác bằng `FILTER` + `CurrentValue`.

### 9.2 Cú pháp

| Cú pháp | Nghĩa | Kiểu |
|---|---|---|
| `[Field]` | Giá trị field ở dòng hiện tại | Scalar |
| `[LinkField].[Field]` | Giá trị field của các record được liên kết; nối chuỗi được: `[LinkA].[LinkB].[Field]` (tối đa 3 bậc) | List |
| `[Table].[Field]` | Toàn bộ giá trị cột của bảng khác (cùng base) | List |
| `[Table]` | Cả bảng, làm phạm vi cho FILTER/COUNTIF/SORTBY | Table |
| `CurrentValue` | Biến lặp trong FILTER/MAP/COUNTIF/SUMIF: là một **dòng** (dùng `CurrentValue.[Field]`) khi phạm vi là bảng, là một **giá trị** khi phạm vi là cột/list | — |

- Toán tử: `+ - * / %`, `= != > >= < <=`, `&&`, `||`, `&` (nối chuỗi). Chuỗi dùng nháy kép.
- Thứ tự ưu tiên (parser Pratt, T451; thấp → cao, toán tử hai ngôi kết hợp trái; ngoặc `(…)` đổi thứ tự):

  | Mức | Toán tử |
  |---|---|
  | 1 | `\|\|` |
  | 2 | `&&` |
  | 3 | `=` `!=` (`<>` là bí danh của `!=`) |
  | 4 | `<` `<=` `>` `>=` |
  | 5 | `&` |
  | 6 | `+` `-` |
  | 7 | `*` `/` `%` |
  | 8 | dấu một ngôi `-` `+` |
  | 9 | `.[Field]`, `.HÀM(…)` (chaining) |

  Ví dụ: `"a" & 1 + 2` ≡ `"a" & (1 + 2)`; `[A] > 1 && [B] < 2 || [C]` ≡ `(([A] > 1) && ([B] < 2)) || [C]`; `-[A].SUM()` ≡ `-(SUM([A]))`.
- Từ vựng: số chỉ dùng `.` thập phân (không phụ thuộc locale, không dấu, không mũ); chuỗi `"…"` escape `\"`, `\\`, `\n`, `\t`, `\r` (`\x` khác giữ nguyên dấu `\`); tên `[…]` escape `\]` và `\\`; tên hàm, `TRUE`/`FALSE`, `CurrentValue` không phân biệt hoa thường; tên field/table phân biệt hoa thường (khớp đúng tên). `[Tên]` đứng một mình là field của table hiện tại, không có thì là table cùng tên trong base (field thắng khi trùng tên).
- `LET(tên1, giá_trị1, …, biểu_thức)`: biến cục bộ, giá trị sau dùng được biến trước; tên biến không trùng tên hàm (kể cả Phase 2), `TRUE`, `FALSE`, `CurrentValue`, không trùng nhau trong cùng một `LET` (không phân biệt hoa thường); `LET` không gọi kiểu chaining.
- Gọi hàm hai kiểu: `SUM([A], [B])` hoặc chaining `[Orders].FILTER(...).[Amount].SUM()`.
- List không dùng như scalar: phải qua `SUM`, `ARRAYJOIN`, `FIRST`, `LAST`, `NTH`… (typecheck báo lỗi rõ ràng).
- FILTER trên bảng **bắt buộc** kết thúc bằng `.[Field]`; field đa giá trị cần `.LISTCOMBINE()` để làm phẳng.
- **Không lồng** FILTER/MAP/SUMIF/COUNTIF bên trong điều kiện của nhau (chaining thì được) — giống giới hạn của Lark, và giúp biên dịch SQL chỉ một tầng subquery. Áp cho cả `SORTBY` và `LOOKUP` (T452).
- **Hệ kiểu** (typecheck, T452; lỗi → `422 FORMULA_TYPE_ERROR`, mã con `TYPE_MISMATCH` (nhánh IF/IFERROR/IFS khác kiểu kèm `params.suggestions` `TEXT` — T470 M5), `LIST_AS_SCALAR` (kèm `params.suggestions` `SUM`/`ARRAYJOIN`/`FIRST`), `NESTED_LIST` (gợi ý `LISTCOMBINE`), `TABLE_NEEDS_FIELD`, `EXPECTED_LIST`, `WRONG_ARGUMENT_COUNT`, `NESTED_ITERATION`, `CURRENT_VALUE_OUTSIDE_ITERATION`, `MIXED_LIST`, `INVALID_ARGUMENT`, `INVALID_LOOKUP`, đều có `params.position`). Tham số **date/datetime vô hướng** nhận thêm kiểu `text` (T470 M4, như Lark: `DAY("2000-01-03")`): chuỗi được ép theo quy tắc `TODATE` ở cả hai backend (§9.4), chuỗi không đọc được → rỗng; tham số list ngày (holidays) vẫn chặt:
  - Kiểu: scalar `text | number | boolean | date | datetime`; giá trị đơn chỉ đến từ field `user`, `attachment`, `row<tbl>` (một record); `list<T>` (một kiểu phần tử); `table<tbl>` (`[Table]`, `[Table].FILTER(…)` — chỉ dùng làm phạm vi hoặc với `.[Field]`); `null` (hợp mọi kiểu, vd `LIST()` là `list<null>`).
  - Kiểu của field: `text`/`auto_number` → `text`; `number` → `number`; `checkbox` → `boolean`; `select` → `text` (đơn) / `list<text>` (`multiple`) theo **tên option**; `datetime` → `date` khi `style.format` không có giờ, còn lại `datetime`; `created_at`/`updated_at` → `datetime`; `user`/`created_by`/`updated_by` → `list<user>`; `attachment` → `list<attachment>`; `link`/`parent` → `list<row<tbl đích>>`; `formula`/`lookup` → `result_type` của field.
  - `[Link].[Field]` và `[Table].[Field]` → `list<kiểu field>`; chuỗi link được làm phẳng (`list<row<…>>`), còn field đa giá trị thành `list<list<T>>` và phải qua `LISTCOMBINE` trước các hàm khác; kết quả công thức là `table` hoặc `list<list<…>>` → lỗi.
  - Toán tử: `+ - * / %` trên số; ngày ± số (ngày) giữ kiểu ngày, ngày − ngày → số ngày; `&` nhận mọi giá trị đơn; `< <= > >=` giữa số, chuỗi hoặc ngày; `= !=` giữa hai giá trị đơn cùng loại (`date` với `datetime`), hai list cùng kiểu phần tử, `user` với chuỗi (user ID), `row` với `row` cùng table (record ID) hoặc với chuỗi (tiêu đề record — primary field — như Lark; riêng chuỗi từ `RECORD_ID()` của đúng table đó so theo record ID). `CONTAIN`/`CONTAINSALL`/`CONTAINSONLY` so phần tử theo cùng quy tắc, riêng chuỗi **không phân biệt hoa thường** (như Lark; định nghĩa fold ở §9.4, T473); một list trong các giá trị cần tìm tính từng phần tử.
  - `CurrentValue` chỉ trong phạm vi lặp (`CURRENT_VALUE_OUTSIDE_ITERATION`): `row<tbl>` khi phạm vi là bảng hoặc list record, phần tử khi là list giá trị.
  - Gợi ý `style` của kết quả: kết quả số/ngày mang `style` của field nó lấy giá trị (`[Số tiền] * 0.1` giữ tiền tệ; `COUNTA`, `LEN` thì không); người tạo đổi được ở T456.
- Lưu trữ: tên được thay bằng ID (`[fld_xxx]`, `[tbl_xxx].[fld_yyy]`); UI hiển thị tên. Đổi tên table/field không làm hỏng công thức. Dạng lưu là văn bản chuẩn hoá (tên hàm viết hoa, một dấu cách quanh toán tử và sau dấu phẩy, ngoặc chỉ khi cần). ID không còn (field/table bị xoá, mất quyền đọc) hiển thị thành `#REF[fld_xxx]`: vẫn parse được, và tự hết lỗi khi ID có lại.

Ví dụ:
```text
IF([Trạng thái] = "Hoàn thành", [Số tiền] * 0.1, 0)
[Khách hàng].[Hạng]
[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên]) && CurrentValue.[Trạng thái] = "Đã giao").[Số tiền].SUM()
COUNTIF([Tickets], CurrentValue.[Người phụ trách] = [Nhân viên] && CurrentValue.[Hạn] < TODAY())
[Tags].FILTER(CurrentValue != "Nội bộ").ARRAYJOIN(", ")
WORKDAY([Ngày nhận], 3)
```

### 9.3 Hàm (MVP)
- Logic: `IF, IFS, SWITCH, IFERROR, IFBLANK, AND, OR, NOT, ISBLANK, ISNULL, ISERROR, ISNUMBER, CONTAIN, CONTAINSALL, CONTAINSONLY, TRUE, FALSE, RECORD_ID`
- Số: `SUM, AVERAGE, MAX, MIN, MEDIAN, COUNTA, COUNTIF, SUMIF, ROUND, ROUNDUP, ROUNDDOWN, FLOOR, CEILING, ABS, INT, MOD, POWER, QUOTIENT, VALUE, RANK`
- Text: `CONCATENATE, LEN, LEFT, RIGHT, MID, FIND, REPLACE, SUBSTITUTE, UPPER, LOWER, TRIM, TEXT, CONTAINTEXT, SPLIT, TODATE, FORMAT, HYPERLINK, ENCODEURL, REGEXMATCH, REGEXEXTRACT, REGEXREPLACE, UNACCENT`
- Ngày: `NOW, TODAY, DATE, YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, WEEKDAY, WEEKNUM, DAYS, DATEDIF, DURATION, EDATE, EOMONTH, WORKDAY, NETWORKDAYS`
- List: `LIST, FIRST, LAST, NTH, FILTER, MAP, SORT, SORTBY, UNIQUE, ARRAYJOIN, LISTCOMBINE`
- Bổ sung ở S4b (đối chiếu Lark, `docs/reviews/lark-gap-analysis.md` §4): `LET, LOOKUP, PRODUCT, SQRT, EXP, LN, LOG, PI, LARGE, SMALL, STDEV`.
  - `LOOKUP(giá_trị, [Bảng].[Field đối chiếu], [Bảng].[Field kết quả], [mode])` theo tài liệu hàm của Lark (https://www.larksuite.com/hc/en-US/articles/914838661184-overview-of-functions-in-base, mục "LOOKUP function"): tra cứu theo điều kiện bằng trên bảng khác, **là cú pháp rút gọn** của `[Bảng].FILTER(CurrentValue.[Field đối chiếu] = giá_trị).[Field kết quả]` (một đường biên dịch, `desugarLookup`), tính vào giới hạn 5 cross-table FILTER, không lồng trong điều kiện. `mode` 1 (mặc định, "split find"): field đối chiếu nhiều giá trị khớp khi **chứa** giá trị (`CONTAIN`); `mode` 0 ("integrated find"): so nguyên danh sách. Khác Lark: luôn trả list (như FILTER) — lấy một giá trị qua `FIRST`/`SUM`…; đối số 2 và 3 bắt buộc dạng `[Bảng].[Field]` cùng bảng (`INVALID_LOOKUP`).
  - Khác biệt khác với Lark (ghi trong mô tả hàm của catalogue): `IFERROR`/`IFBLANK` coi lỗi và rỗng như nhau; `DURATION` trả **số ngày** (cộng/trừ với ngày); `SUMIF` có thêm dạng `SUMIF([Bảng], điều_kiện, giá_trị)` cho phạm vi là bảng; `ROUND*`/`LEFT`/`RIGHT` cho phép bỏ đối số thứ hai (mặc định 0 / 1); `MAX`/`MIN` nhận cả ngày; tham số date/datetime vô hướng nhận **chuỗi ngày** (T470 M4, như Lark): đọc theo quy tắc `TODATE` (`DAY("2000-01-03")`, `HOUR("11:40:59")` — giờ không ngày cũng nhận, `TEXT("2021-01-01", "ddd")`), không đọc được → rỗng.
- Phase 2: `RANDOMBETWEEN, RANDOMITEM, SEQUENCE, REGEXEXTRACTALL`, lượng giác, `DISTANCE`.

Mỗi hàm có trong `packages/formula-engine/src/functions/<NAME>.ts` gồm: chữ ký kiểu (overload, variadic), nhóm, mô tả + ví dụ (en/vi), cờ `volatile` (`NOW`, `TODAY`), cài đặt TS (T453); cài đặt SQL ở `packages/server-core/src/formula/sql/<name>.ts` (T454). Hàm Phase 2 có mục riêng trong catalogue (`phase2: true`) để editor giải thích, parser vẫn trả `UNSUPPORTED_FUNCTION`.

### 9.4 Hai backend, một AST

```text
input → lexer → parser (Pratt) → AST → resolve tên→ID → typecheck → { SQL compiler | TS evaluator }
```

- **SQL compiler (backend chính trên server)**: biên dịch AST thành biểu thức SQL để tính `stored` (UPDATE set-based) và `virtual` (chèn vào SELECT). Link chain → subquery qua junction; `[Table].FILTER(...)` → correlated subquery `SELECT … FROM data.t_x AS cv WHERE <điều kiện với cv.*> `; aggregate → `sum/avg/array_agg/count` tương ứng.
- Hàm không biểu diễn trực tiếp được bằng SQL chuẩn (`WORKDAY`, `NETWORKDAYS`, `TEXT` với định dạng, `FORMAT`, `DATEDIF`…) được cài đặt thành hàm SQL `IMMUTABLE` trong schema `fx` (tạo bằng migration), tên `fx.workday(...)`.
- **Timezone tường minh** (ADR-21): mọi phép phụ thuộc lịch (`timestamptz → date`, `YEAR/MONTH/DAY/HOUR/WEEKDAY/WEEKNUM`, `TODAY`, `DATEDIF`, `WORKDAY`, `NETWORKDAYS`, `TEXT`/`FORMAT` ngày) nhận timezone là **tham số** (literal IANA lấy từ timezone của field, không thì của org), vd `fx.year(ts, 'Asia/Ho_Chi_Minh')` ≡ `extract(year FROM ts AT TIME ZONE $tz)`. Hàm `fx.*` **MUST NOT** đọc `TimeZone`, `lc_*`, `DateStyle` của session, vì vậy mới thật sự `IMMUTABLE`. Định dạng số/ngày trong `TEXT` dùng pattern cố định, không phụ thuộc locale của session. Đổi timezone của org/field → job backfill lại mọi computed field `stored` bị ảnh hưởng. Connection pool vẫn đặt `SET TIME ZONE 'UTC'` làm lớp phòng thủ thứ hai.
- **Lỗi cấp field** (T460, CONTRACTS §13): ngoài lỗi từng dòng (`NULL`), cả field có thể lỗi: `REF` (đối tượng được tham chiếu vào thùng rác/purge, hoặc đọc một computed đang lỗi), `CIRCLE` (khôi phục khép một vòng tham chiếu), `INVALID_CONFIG` (đổi kiểu làm định nghĩa không còn qua typecheck), `TIMEOUT` (lô backfill/recompute quá 30 s hai lần liên tiếp, lần 2 với nửa số dòng; chờ khoá/deadlock không phải timeout — T474). Đặt/xoá trong cùng transaction với thay đổi schema; field lỗi đọc `NULL`, không được tính lại; hết lỗi (khôi phục, sửa định nghĩa) → backfill.
- Phép có thể lỗi dùng biến thể an toàn (`fx.div`, `fx.value`, `fx.todate`) trả `NULL` thay vì raise → không làm hỏng cả câu UPDATE. `IFERROR(x, y)` ≡ `COALESCE(x, y)`; `ISERROR(x)` ≡ x là NULL trong khi các input không NULL. Khác biệt nhỏ so với Lark (lỗi và rỗng gộp làm một) được ghi trong tài liệu người dùng.
- **Quy ước giá trị chung của hai backend** (chốt ở T454, harness TS ≡ SQL kiểm; `packages/server-core/src/formula/**`, hàm `fx.*` ở migration `0021_fx_functions`, `TEXT`/fold thay ở `0023_fx_text_contain` — T473):
  - Biểu diễn SQL: `text` → `text` (collation của cột), `number` → `numeric`, `boolean` → `boolean`, `date` → `date`, `datetime` → `timestamptz`, `user` → `text` (user id), `attachment` → `jsonb`, `list<T>` → mảng `T[]` (`list<null>` → `text[]`); list rỗng ≡ `NULL`. Select là **tên option** (ánh xạ id → tên qua hai mảng tham số); `created_by`/`updated_by` là list một user. Kết quả số bỏ số 0 thừa (`trim_scale`).
  - Rỗng: phép số và hàm một đối số truyền `NULL` (strict); boolean rỗng tính là FALSE (`AND`/`OR`/`NOT`/`IF`/điều kiện); `&`, `CONCATENATE`, `FORMAT` coi rỗng là chuỗi rỗng; hàm gộp (`SUM`, `AVERAGE`, `MAX`, `COUNTA`…) bỏ qua phần tử rỗng (`SUM`/`COUNTA` của không gì là 0, `AVERAGE`/`MAX`/`MIN`/`MEDIAN` là rỗng, `PRODUCT` là 0 như Excel/Lark).
  - So sánh: `=`/`!=` luôn ra TRUE/FALSE — chuỗi rỗng bằng rỗng, giá trị rỗng khác chỉ bằng rỗng; `<`… với một bên rỗng là FALSE; `date` so với `datetime` theo thời điểm (ngày = 0 h theo timezone); user so với chuỗi theo id; chuỗi phân biệt hoa thường.
  - **`CONTAIN`/`CONTAINSALL`/`CONTAINSONLY` không phân biệt hoa thường** (T473, tài liệu Lark CONTAIN): khi mọi đối số là chuỗi thường hoặc record (so theo tiêu đề), cả hai phía được **fold** trước khi so; có user ID, `RECORD_ID()`, số/ngày/boolean trong lời gọi → cả lời gọi so chính xác (user/record ID phân biệt hoa thường; record với record vẫn theo id). `LOOKUP` mode 1 (dựa trên `CONTAIN`) theo cùng quy tắc. **Ngoại lệ**: điều kiện `where` của field lookup giữ ngữ nghĩa Filter DSL — `lookupToAst` sinh `CONTAIN*` nội bộ có cờ `exact` trên node AST (không có trong parser/serialize, người dùng không gõ được), so chính xác không fold: option select khớp theo đúng tên (option `Done` và `done` không khớp nhau qua `is_any_of`/`has_any_of`/`has_all_of`/`is_exactly`…), còn `CONTAIN` người dùng gõ vẫn fold. **Fold** = `LOWER` = ánh xạ chữ thường **đơn** Unicode (Simple_Lowercase_Mapping, UnicodeData.txt cột 13) của **Unicode 16.0**, từng code point, không ngữ cảnh, không theo ngôn ngữ: SQL `fx.fold(t)` ≡ `lower(t COLLATE pg_c_utf8)` (collation built-in, không phụ thuộc collation của cột, ICU, `lc_ctype`), `fx.fold_all(text[])` cho mảng; TS `foldCase` dùng bảng cố định sinh từ PostgreSQL 18 (`packages/formula-engine/src/evaluate/case-fold.ts`, **không** dùng `toLowerCase()` vì đó là ánh xạ đầy đủ và theo phiên bản Unicode của engine); test int so từng code point `fx.fold` ↔ `foldCase` và `unicode_version() = 16.0` (nâng PostgreSQL đổi Unicode → sinh lại bảng). Hệ quả: `İ` → `i` (không thành `i̇`), `I` → `i` (không có quy tắc Thổ Nhĩ Kỳ; `ı` giữ nguyên), `ß` giữ `ß` và **không** bằng `ss`, `ẞ` → `ß`, `Σ` → `σ` (`ς` giữ nguyên, không bằng `σ`), `K` (Kelvin) → `k`; tiếng Việt: `Ấ` → `ấ`, `Đ` → `đ`, dấu vẫn tính (`"noi bo"` ≠ `"Nội bộ"`, bỏ dấu dùng `UNACCENT`); không chuẩn hoá Unicode (NFC ≠ NFD). `=`/`!=`, `CONTAINTEXT`, `FIND` vẫn phân biệt hoa thường.
  - **`LOWER`/`UPPER`** (T473): cùng định nghĩa, không theo collation của cột — ánh xạ chữ thường/chữ hoa **đơn** Unicode 16.0 từng code point: SQL `fx.lower(t)` ≡ `lower(t COLLATE pg_c_utf8)`, `fx.upper(t)` ≡ `upper(t COLLATE pg_c_utf8)` (kết quả giữ collation của đối số); TS `lowerCase`/`upperCase` dùng hai bảng sinh từ PostgreSQL 18 (`case-fold.ts`), test int so từng code point. Hệ quả: `LOWER("İ")` = `i`, `UPPER("ı")` = `I`, `UPPER("ß")` = `ß` (không thành `SS`), `LOWER("ẞ")` = `ß`, `LOWER("ΟΔΟΣ")` = `οδοσ` (không có quy tắc sigma cuối), `UPPER("ǆ")` = `Ǆ`; tiếng Việt `Đ`/`đ`, `Ấ`/`ấ` như thường.
  - Chuyển sang text (`&`, đối số text): số không số 0 thừa, không mũ; `TRUE`/`FALSE`; ngày `YYYY-MM-DD`; datetime `YYYY-MM-DD HH:mm:ss` theo timezone; user theo id; attachment theo tên.
  - Ngày: `date ± n` cộng số ngày nguyên (`floor`), `datetime ± n` cộng đúng n × 86 400 giây; `date − date` ra số ngày nguyên, có datetime thì ra số ngày thập phân. Đối số nguyên (số chữ số, số ký tự, vị trí, số tháng…) cắt phần thập phân về phía 0. Độ dài/vị trí chuỗi tính theo **code point** Unicode (emoji = 1).
  - Lỗi từng dòng → `NULL` (không làm hỏng cả câu): chia/`MOD`/`QUOTIENT` cho 0, `VALUE`/`TODATE` hỏng, `SQRT` âm, `LN`/`LOG` ngoài miền, `POWER` 0^âm / âm^lẻ / vượt 10^±1000, `EXP` > 2302, ngày ngoài năm 1–9999, `LARGE`/`SMALL`/`NTH` ngoài phạm vi, pattern `REGEX*` hỏng (bắt lỗi trong `fx.regex_*`), `WORKDAY` quá 100 000 ngày.
  - Định dạng cố định (không `to_char`, không đọc `DateStyle`/`lc_time`), `TEXT` theo mẫu Lark (T473, `fx.text_number`/`fx.text_date`):
    - Số: mẫu `[#0,]…[.[#0]…][%]` — phần nguyên (≤ 40 ký tự) mỗi `0` là chữ số tối thiểu, `#` là chữ số tuỳ chọn, `,` giữa các ký hiệu → nhóm nghìn bằng `,` (`#,##0.00`, `0,0`); sau `.` (≤ 20 ký hiệu) làm tròn đúng số ký hiệu (nửa ra xa 0), bỏ số 0 cuối tới ký hiệu `0` cuối cùng (`0.0#`: `1.5` → `1.5`, `1.255` → `1.26`); `%` nhân 100. Như Excel: phần nguyên bằng 0 mà mẫu không có `0` thì bỏ (`TEXT(0.5, "#.##")` → `.5`, `TEXT(0, "#")` → `""`), dấu `.` luôn giữ (`TEXT(23, "##.##")` → `23.`), số âm làm tròn về 0 không có dấu `-`. Mẫu có ký tự khác (chữ, khoảng trắng, `,` đầu/cuối — chia 1000 kiểu Excel —, nhiều `%`) → rỗng.
    - Ngày: token **không phân biệt hoa thường** (chỉ chữ ASCII, `upper(fmt COLLATE "C")`, nên `ſ`/`ı` không thành token), khớp dài nhất trước: `YYYY` `YY` `MMMM` (January) `MMM` (Jan) `MM` `M` `DDDD` (Friday) `DDD` (Fri) `DD` `D` `HH`/`hh` `H`/`h` (24 giờ, như Lark) `SS`/`ss`; `MM`/`M` ngay sau token giờ hoặc ngay trước `SS` (bỏ qua ký tự khác ở giữa) là **phút** (như Excel: `hh:mm`, `mm:ss`), còn lại là tháng. Tên tháng/thứ tiếng Anh cố định, không theo locale. `Y`/`S` lẻ và mọi ký tự khác giữ nguyên. `[h]`/`[mm]`/`[ss]` (thời lượng) là Phase 2 → rỗng. `TODATE` nhận `YYYY-M-D` / `YYYY/M/D`, tuỳ chọn ` H:mm[:ss]` (hoặc `T`), là giờ địa phương theo timezone.
    - **Chuỗi ở tham số date/datetime** (T470 M4, cả hai backend cùng quy tắc): day-based (`YEAR/MONTH/DAY/WEEKDAY/WEEKNUM/DAYS/DATEDIF/EOMONTH/WORKDAY/NETWORKDAYS`) đọc chuỗi bằng quy tắc `TODATE` (`fx.date_text_arg(t, tz)` = `local_date(todate(t, tz))`, migration 0025); wall-clock (`HOUR/MINUTE/SECOND`, `TEXT` với mẫu ngày) nhận thêm giờ không ngày `H:mm[:ss]` đọc tại 1970-01-01 trong timezone (`fx.wall_time(t, tz)` — như `HOUR("11:40:59")` của Lark). `TEXT(text, mẫu)` chỉ có mẫu chứa chữ `Y M D H S` (sau khi in hoa theo collation `C`) mới đọc chuỗi thành ngày (`fx.text_text`), mẫu khác trả nguyên văn. Chuỗi không đọc được → `NULL`; SQL identifier/literal không đổi (tham số hoá như thường). TS evaluator đọc chuỗi ở tham số ngày bằng đúng quy tắc `TODATE` (`parseTodate`): không nhận phần lẻ giây, `Z`/độ lệch múi giờ hay khoảng trắng khác dấu cách — khác `parseDateText` (vẫn dùng để đọc giá trị ô ngày và `now`); trước T470 chuỗi không tới được tham số ngày nên không case cũ nào đổi nghĩa. `VALUE` nhận số thập phân thường (dấu, `.`, mũ 1–3 chữ số), không nhận dấu phân cách nghìn. `HYPERLINK(url, nhãn)` → `[nhãn](url)` (không nhãn → url). `ENCODEURL` như `encodeURIComponent`. `SPLIT("", sep)` → list rỗng, `sep` rỗng → cả chuỗi. `DATEDIF` start > end hoặc đơn vị lạ → rỗng; `WEEKDAY`/`WEEKNUM` kiểu khác 1/2 → rỗng. `REGEXEXTRACT` trả cả đoạn khớp; pattern > 500 ký tự → rỗng, chỉ áp cho 10 000 ký tự đầu.
  - `ISERROR(x)` ≡ `x` rỗng trong khi mọi `[Field]` nó đọc đều có giá trị. `LET` được inline (mỗi lần dùng lặp lại SQL của giá trị).
  - SQL compiler T454 chỉ biên dịch phần cùng dòng (gồm `FILTER`/`MAP`/`COUNTIF`/`SUMIF` trên list giá trị); link, `[Table]`, lặp trên record, `SORTBY`, `LOOKUP` đi qua `FormulaSqlContext.extension` (T455).
  - **Chéo bảng** (T455, `packages/server-core/src/formula/cross/**`): một record (`row<tbl>`) là `__id` (`text`), list record là `text[]` id; `[Table]`, ô link, chuỗi link (≤ 3 bậc, cả phía `b`, self-link, `parent`), kết quả `FILTER`/`SORTBY` là tập record chưa vật chất hoá, thành **một** subquery tương quan khi cần giá trị (`.[Field]`, `COUNTIF`, `SUM`…); chuỗi link là join nối tiếp qua junction, không subquery từng bậc. Thứ tự: `[Table]` theo `__auto`; ô link phía `a` theo `position` rồi `__auto`, phía `b` theo `__auto`; chuỗi link làm phẳng theo thứ tự đó (record được hai record liên kết thì xuất hiện hai lần). Chỉ record còn sống; table trong thùng rác (hoặc đã purge) đọc như rỗng (C§13). Record so với record cùng table và với `RECORD_ID()` của table đó theo id, với chuỗi khác theo **tiêu đề** = primary field chuyển sang text như `&` (rỗng → `""`; không phải định dạng `cell_format=text` theo locale); `&`/`ARRAYJOIN` của record là tiêu đề. `SORTBY` như `SORT` (rỗng cuối, hoà giữ thứ tự cũ). `LOOKUP` biên dịch trực tiếp thành `[Bảng].FILTER(…).[Field]`; field lookup đi qua `lookupToAst` rồi cùng compiler. List của list (`[Link].[Field đa giá trị]`, `MAP` ra list) chỉ nhận ở `LISTCOMBINE`, `COUNTA`, `ISBLANK` (chỗ khác → lỗi biên dịch). Hạng tử `&&` cấp cao nhất của điều kiện FILTER là các mục `WHERE` riêng, `CONTAIN` trên record là `EXISTS` không bọc `coalesce` để PostgreSQL lập semi-join. **Quyền**: compiler nhận `sourceScope(tableId, alias)` (điều kiện read rule của **người xem** trên mỗi table nguồn, kể cả qua link/self-link; `null` = không lọc, cho giá trị `stored`), không tự đọc quyền; `viewerSourceScope` dựng nó từ `RecordAccessContext` (T457 cắm vào).
- **TS evaluator**: dùng cho preview khi đang gõ công thức (trên dữ liệu mẫu), template automation (§11.4), và test. **Không** dùng để tính giá trị lưu. Công thức có `REGEXMATCH`/`REGEXEXTRACT`/`REGEXREPLACE` **không** preview bằng TS evaluator trong trình duyệt (regex JS quay lui luỹ thừa với pattern lồng lượng từ) mà qua `computed-preview` của server (T470 H2, F§4.6); template automation (§11.4) **cấm** `REGEX*` (`docs/reviews/S4b-decisions-followup.md` §1, T504): kiểm khi lưu → `422 AUTOMATION_INVALID` / `UNSUPPORTED_FUNCTION`, và evaluator phía server chạy với `disallow` nên không đường nào tới `RegExp` trên worker.
- **Test tương đương bắt buộc**: bộ fixture ≥ 300 case; mọi hàm chạy cả TS evaluator và SQL (Testcontainers) phải cho cùng kết quả.
- **TS evaluator và fixture chung (T453)**: `evaluate(ast, { snapshot, row, resolve, tz, now, locale })` duyệt AST đã typecheck (không sinh mã) và theo đúng các quy ước trên (số là decimal khớp `numeric`, phép chia theo `select_div_scale`; zone riêng của field datetime `options.timezone` giữ qua `LET`/cộng trừ ngày, mất khi qua lời gọi hàm như compiler; giờ địa phương theo `AT TIME ZONE` của PG: giờ bị bỏ qua khi DST bắt đầu dời lên, giờ lặp khi DST kết thúc lấy thời điểm sau); kết quả JSON (số dạng chuỗi thập phân, list rỗng = `null`). Fixture dữ liệu chung ở `packages/formula-engine/test/fixtures/` (`formula-schema.json`, `formula-cases.json`, 1072 case (đếm lại ở T471) gồm cả case tạm của T454, 86 case `t473-…` và 38 case `m4-…` của T470; case có `lookup` (theo tên) chạy `lookupToAst` thay cho công thức, mỗi case có `scope` `same_row`/`cross_table`, định dạng và ngữ nghĩa trong `README.md` cùng thư mục); harness SQL của T454 đọc cùng fixture qua `packages/server-core/test/formula/fixture-source.ts`.

### 9.5 An toàn & giới hạn
- **MUST NOT** dùng `eval`, `new Function`, `vm`, hay nối chuỗi SQL từ nội dung công thức: SQL compiler chỉ sinh node Kysely; literal luôn là parameter; identifier chỉ lấy từ meta.
- Công thức chỉ tham chiếu được table trong cùng base, và bị kiểm tra quyền: người **tạo/sửa** công thức phải có quyền đọc mọi table/field được tham chiếu. Người **xem** không có quyền với field nguồn **của cùng record** vẫn thấy kết quả (giống Lark) **trừ khi** field nguồn là `no_perm` với role của họ và admin bật cài đặt base `strict_computed_permissions` (`meta.bases.settings`, `PATCH /bases/:id`, C§5A) → khi đó kết quả bị ẩn (`null` + `locked`, P36). Giá trị đọc từ **record khác** (table nguồn, field được lấy, field điều kiện) mà người xem không đọc được thì luôn bị ẩn (§5.8, P34); người xem có record rule đọc trên table nguồn nhận giá trị tính theo phạm vi đọc của chính họ (§5.8, P35) — không bao giờ theo quyền người tạo field. Người không có quyền schema không thấy biểu thức (C§13).
- Độ dài ≤ 4.000 ký tự (dạng hiển thị), độ sâu AST ≤ 50 (tính trên dạng n-ngôi đã làm phẳng: mỗi lần gọi hàm, ngoặc, dấu một ngôi, `LET`, `.[Field]`/`.HÀM()` là một mức; một chuỗi toán tử hai ngôi cùng mức ưu tiên kết hợp trái như `[a] + [b] - [c] + …` chỉ tính **một** mức, nên cộng phẳng nhiều số hạng vẫn hợp lệ trong giới hạn 4.000 ký tự), chuỗi link ≤ 3 bậc, tối đa 5 cross-table FILTER trong một công thức (`FILTER`/`COUNTIF`/`SUMIF`/`MAP`/`SORTBY` trên `[Table]`), ≤ 255 đối số mỗi lần gọi hàm (tính cả đối tượng chaining), ≤ 20 biến `LET` trong một công thức. Vượt → `FORMULA_LIMIT_EXCEEDED` với `params.limit`.
- `statement_timeout` cho câu tính lại: 30s/batch; quá hạn → chạy lại lô với nửa số dòng, quá hạn lần nữa liên tiếp → field đánh dấu `error` (`TIMEOUT`), thông báo người tạo. Mọi khoá của lô job chờ tối đa `lock_timeout` (3 s): chờ khoá (`55P03`), deadlock (`40P01`), lỗi tuần tự hoá (`40001`) → chạy lại lô với backoff luỹ thừa, không đổi trạng thái field; vẫn bị chặn → job lỗi, graphile-worker thử lại không mất tiến độ (T474).
- SQL biên dịch của một formula/lookup ≤ 512 KiB văn bản và ≤ 4.096 tham số (biến `LET` và các hàm dùng lại toán hạng lặp SQL của giá trị, có thể nở theo hàm mũ); kiểm trong lúc biên dịch, dừng ở node đầu tiên vượt → `422 FORMULA_LIMIT_EXCEEDED` / `MAX_COMPILED_SIZE` (C§6).
- Tối đa 200 computed field/base (env `COMPUTED_FIELDS_MAX_PER_BASE`, §20) để giữ dependency graph dễ kiểm soát; vượt → `422 FORMULA_LIMIT_EXCEEDED` / `MAX_COMPUTED_FIELDS` (C§13).

### 9.6 Trình soạn công thức (UI)
- Editor có tô màu cú pháp, autocomplete tên table/field/hàm, hiển thị chữ ký + ví dụ hàm, báo lỗi typecheck theo vị trí, preview kết quả trên 5 dòng đầu.
- Nút "AI viết công thức" (khi bật AI, §12).

## 10. Dashboard

Mỗi base có nhiều dashboard. Chỉ base owner và role `admin` (§14.1) tạo/sửa/xoá được; role `editor`/`reader` hệ thống xem mọi dashboard; role custom xem theo `dashboards.<id>` (`read_only` | `no_perm`). Người xem dùng được filter control. Dashboard **tuỳ biến hoàn toàn** trong phạm vi dưới đây.

### 10.1 Layout & giao diện
- Mô hình và API: C§28 (T805, ADR-38). Vị trí `{x, y, w, h}` lưu **trên từng widget** (không trên dashboard); `PUT /dashboards/:id/layout` ghi một lần mọi vị trí, server kiểm lưới 12 cột + không chồng nhau rồi lưu bản compact dọc. Mọi thay đổi tăng `version` của dashboard (`If-Match` → `409 VERSION_CONFLICT`). Xoá dashboard vào thùng rác base 30 ngày, khôi phục kèm widget. Widget giữ cấu hình khi table/field nó dùng bị xoá và hiện trạng thái `broken`.
- Lưới 12 cột (react-grid-layout): kéo thả, resize, nhân bản widget, nhân bản cả dashboard, undo/redo trong phiên sửa. Chế độ "Sửa" và "Xem" tách biệt.
- Responsive: ≥ 1024px dùng layout 12 cột; nhỏ hơn tự xếp 1 cột theo thứ tự (y, x). Không cần lưu layout riêng cho mobile ở MVP.
- `theme`: sáng/tối/theo hệ thống, màu nền, bảng màu (palette) mặc định cho chart, bo góc/khoảng cách widget (compact/comfortable).

### 10.2 Widget MVP
| Loại | Tuỳ biến |
|---|---|
| `kpi` | 1 metric; định dạng số; tiền tố/hậu tố; **so sánh kỳ trước** (% tăng/giảm theo date field + khoảng); ngưỡng màu (vd < 80% đỏ, ≥ 100% xanh); mục tiêu (target) → hiển thị tiến độ |
| `bar` | dọc/ngang; stacked hoặc grouped theo dimension thứ hai; tối đa 5 metric; nhãn giá trị |
| `line` | tối đa 5 metric hoặc chia series theo dimension thứ hai; area fill tuỳ chọn; smooth |
| `pie` | pie/donut; gộp phần nhỏ thành "Khác" khi vượt N lát |
| `table` | cột = dimension + metrics (pivot 1 chiều) hoặc danh sách record top N với field chọn; tô màu có điều kiện |
| `text` | Markdown (sanitize bằng DOMPurify, không HTML thô, không script) — tiêu đề, ghi chú, link |
| `filter_control` | Bộ lọc tương tác cho người xem: date range, select, user, text search; gắn vào các widget chỉ định |

Mọi widget chart có: tiêu đề, mô tả, màu theo palette hoặc màu riêng từng series/option (`select` dùng màu của option), hiện/ẩn legend, nhãn trục, định dạng số (theo field hoặc tuỳ chỉnh), sort (`metric_desc|metric_asc|dimension_asc|dimension_desc`), limit, trạng thái rỗng tuỳ chỉnh, click-through (bấm cột → mở danh sách record tương ứng, tôn trọng quyền).

Phase 2: scatter, funnel, heatmap, gauge, map, image, embed iframe, widget nhiều bảng (join), công thức metric tuỳ chỉnh (vd `sum(a)/count()`).

### 10.3 Định nghĩa widget

```json
{
  "type": "bar",
  "title": "Doanh thu theo trạng thái",
  "table_id": "tbl_x",
  "filter": { "op": "and", "items": [] },
  "dimension": { "field": "fld_status", "date_bucket": null },
  "series_dimension": { "field": "fld_region" },
  "metrics": [{ "id": "m1", "aggregation": "sum", "field": "fld_amount", "label": "Doanh thu", "color": null }],
  "sort": "metric_desc",
  "limit": 20,
  "display": { "orientation": "vertical", "stacked": true, "show_legend": true, "show_values": false, "number_format": { "style": "currency", "currency": "VND", "compact": true } },
  "filter_bindings": ["wgt_date_control"]
}
```

- aggregation: `count, count_distinct, sum, avg, min, max`. `date_bucket`: `day, week, month, quarter, year`.
- Dimension cho phép: text, select (đa chọn: mỗi option một nhóm), user, checkbox, date/datetime (bắt buộc bucket), number (bucket khoảng tuỳ chọn), link (theo primary field bản ghi đích).
- Chạy qua `RecordQueryService.widgetData` (T806 — không có service aggregate riêng; cùng pipeline quyền §7.2: record rules kể cả field link, field permissions, table đích của link; `POST /api/v1/widgets/:id/data`, C§28.3). Widget dùng field người xem không có quyền (kể cả trong filter đã lưu) → `status: no_permission`, client hiển thị "Không có quyền", không lộ số nào.
- Global filter (date range + filter theo field) và `filter_control` được merge (AND) vào filter từng widget liên kết.

### 10.4 Cache & làm mới
- Valkey key: `dash:{widget}:{hash(effective_query)}:{permFingerprint}:{tableDataVersion}`; `tableDataVersion` = `meta.tables.data_version`, counter tăng trong cùng transaction ghi record → không cần invalidate chủ động. TTL 5 phút (± 10 %, chỉ để dọn). T807: `tableDataVersion` gồm mọi table nguồn (table của widget và các table tới được qua field link — lookup, tiêu đề link); gom request trùng bằng `SET NX` + chờ ≤ 2 s; Valkey lỗi → tính không cache (CONTRACTS §28.5). `effective_query` gồm cả `locale` người xem (tiêu đề link); bảng `records` không cache (ô button phụ thuộc quyền sửa của người xem và trạng thái automation, CONTRACTS §28.5).
- `permFingerprint` = hash tập record rules **đã thay biến** (`current_user`, nhóm, ngày) + field đọc được của principal trên các table nguồn (với share link: của link, §15A) — hai người cùng role có rule theo `current_user` không bao giờ dùng chung mục cache; không tính được → không cache.
- Làm mới: realtime cho người đăng nhập (event ghi table → client refetch widget liên quan, debounce 5s); auto-refresh interval tối thiểu 30s cho share link/màn hình TV.
- Chế độ trình chiếu (fullscreen/TV mode), xuất PNG từng widget (ECharts `getDataURL`), xuất CSV dữ liệu của widget (theo quyền, ghi audit).

## 11. Automation engine

### 11.1 Luồng

```text
mutation (transaction) → meta.events (có batch + via, ADR-26) + job events.dispatch
worker events.dispatch:
  → tìm automation enabled có trigger khớp (event type + table)
  → bỏ qua event hàng loạt nếu trigger có skip_bulk (ADR-26)
  → loop guard (§11.6)
  → trần fan-out theo lô (ADR-26)
  → load record mới nhất + before/after từ payload
  → evaluate condition (filter-dsl evaluate)
  → tạo automation_run (status=queued, trigger_unit) + job automation.run
  (trạng thái run: queued | running | waiting (đang trong delay, ADR-18) | succeeded | failed | skipped | cancelled)
worker automation.run:
  → resolve quyền hiệu lực của run_as (ADR-25) tại thời điểm chạy
  → chạy tuần tự actions; mỗi action: tạo run_step với idempotency_key TRƯỚC khi gọi side effect
  → retry theo policy; hết retry → run status=failed (DLQ = runs failed, có nút "chạy lại")
```

**Cài đặt (T505)**: `AutomationRunEngine` (`packages/server-core/src/automation/engine`), task `apps/worker/src/tasks/automation-run.ts`. Một job xử lý một run: run `queued` lấy chỗ theo trần org (§11.7) rồi `running`; run `running` (worker chết giữa chừng) chạy tiếp từ bước chưa `succeeded`; trạng thái khác → không làm gì (job giao lại hai lần vô hại). Định nghĩa là bản chụp trong `input` (sửa automation sau khi run được tạo không đổi run). Trước bước đầu: `REGEX*` trong template → bước chứa nó `failed` `unsupported_function`; `run_as` không còn truy cập base → run `failed` `permission_denied` (`params.scope = base`). Mỗi action có handler đăng ký trong `AutomationActionRegistry` (T505: action record + `if`; T506: `update_records`, `delay`; T514–T516 thêm của mình) — action chưa có handler → bước `failed` `unsupported_action`. Ghi record: `RecordMutationService` với quyền `run_as` lúc chạy, `actor_type = automation`, `via = { automation_id, run_id }`, `batch_id = run_…`, `causation` = event trigger + 1 tầng + automation nối vào chain (loop guard §11.6 của `events.dispatch` thấy được); bước ghi được đánh `succeeded` **trong cùng transaction** với thay đổi record (`beforeCommit`/`onCreated`), nên chạy lại không bao giờ ghi hai lần. Kết thúc: event + audit `automation.run.succeeded|failed` (C§8, C§21) cùng transaction với trạng thái run; run `failed` gọi `tripOnConsecutiveFailures` (ADR-26 §5); lỗi quyền cấp bảng/field/base gọi `RunAsAccessCheck` (T507 nối `automation.revalidate_run_as`), lỗi theo record (P29) không tắt automation. Ghi realtime như ghi thường (publisher của `RecordMutationService`, có meta field `virtual` — S4b-review §4 #13 không cần làm thêm).

Không thực thi automation trong transaction của request.

**Cài đặt (T503)**: `events.dispatch` chạy trong một transaction với `dispatched_at` (job chạy lại không tạo gì); điều kiện được đánh giá **trước** trần fan-out (trần đếm run, không đếm event) — `changed*` trên `changes` của event, phần còn lại trên record mới nhất đọc bằng quyền `run_as` (`record.deleted`: record trong thùng rác); breaker kiểm trước trần. Chi tiết, lý do bỏ qua và dạng run: C§21 "Dispatch".

**Quyền chạy (ADR-25)**: mọi action chạy bằng quyền hiệu lực của `run_as_user_id`. `run_as` là người bật hoặc sửa `definition` gần nhất (không phải `created_by`). Người sửa phải quản lý được automation và định nghĩa phải hợp lệ với quyền của chính họ (`422 AUTOMATION_INVALID`). UI cảnh báo khi lưu sẽ chuyển `run_as`. `run_as` mất quyền (rời org, bị gỡ role, định nghĩa không còn hợp lệ với quyền của họ) → automation tắt ngay (`disabled_reason = run_as_lost_access`), run đang chờ bị `cancelled`, báo owner + admin base. `POST /automations/:id/take-over` cho người quản lý khác nhận `run_as` và bật lại. Audit `automation.run_as_changed`. **Nhân bản** (`POST /automations/:id/duplicate`, T551, C§21) là một lần tạo của người gọi: bản sao cùng base, tắt, `run_as` = người gọi, định nghĩa kiểm bằng quyền người gọi; ảnh thân thư được chép thành ảnh riêng của bản sao (cùng org); automation `button.clicked` không nhân bản được (một nút một automation).

**Cài đặt (T507)**: job `automation.revalidate_run_as` (`RunAsRevalidator`, `packages/server-core/src/automation/revalidate`) được enqueue cùng transaction với mọi lần tăng `permission_version` của base có automation đang bật (gồm gỡ thành viên org) và khi run gặp lỗi quyền cấp bảng/base; kiểm lại từng automation đang bật bằng quyền hiện tại của `run_as` (cùng hàm kiểm khi lưu); định nghĩa chỉ hỏng vì schema (vẫn sai với quyền admin) không bị tắt. Chi tiết C§21 "`run_as` mất quyền", C§12.2.

### 11.2 Trigger (MVP)

| Trigger | Config |
|---|---|
| `record.created` | table_id, `skip_bulk` (mặc định `false`, ADR-26) |
| `record.updated` | table_id, `watch_fields` (bắt buộc ≥ 1 field; chỉ kích hoạt khi một trong các field này đổi giá trị — kể cả formula/lookup `stored` đổi do tính lại, §5.9; field `virtual` trong `watch_fields`/`changed*` → `422 AUTOMATION_INVALID` / `INVALID_FIELD_TYPE`, dùng `stored` hoặc `record.date_reached`/`schedule`), `skip_bulk` |
| `record.deleted` | table_id, `skip_bulk` |
| `record.date_reached` | table_id, `field_id` (`datetime`, `created_at`, hoặc formula `stored` kiểu ngày), `offset_minutes` (−43.200 … 43.200), `time_of_day` (field chỉ ngày, mặc định `09:00` theo timezone field). Chạy **một lần** cho mỗi (record, giá trị field); giá trị đổi → lên lịch lại. Chỉ bắn khi thời điểm đi qua **sau** khi automation bật (không bắn bù cho giá trị đã qua) |
| `form.submitted` | view_id (form) |
| `webhook.received` | `incoming_webhook_id` — hook **chưa xoá của cùng base** (`UNKNOWN_WEBHOOK`). Một run cho mỗi request được nhận (replay `webhook-id` không tạo gì), theo thứ tự id automation; không có record nên `condition` phải `null` (`INVALID_CONDITION` — lọc request bằng bước `if` trên giá trị webhook); chỉ base admin tạo/sửa/bật/nhận lại (người `manage` table → `403`, như `schedule` — BACKLOG "Quyết định S5c" #7). Run `input.trigger = { type, event_id, incoming_webhook_id, request_id }`; dữ liệu đọc từ dòng request (§11.4). Hook bị xoá trước khi run (hoặc lần chạy tiếp sau `delay`) bắt đầu → run `failed` `webhook_deleted`. Mảng JSON ở gốc body là **một** run (ADR-35 §2; T604, C§21 "Trigger webhook") |
| `schedule` | cron (5 trường), timezone (mặc định theo org), tối thiểu mỗi 5 phút |
| `record.matches` | table_id, `condition` (Filter DSL, ≥ 1 điều kiện — `EMPTY_FILTER`, không `changed*`, không formula/lookup `virtual` — `INVALID_FIELD_TYPE`), `skip_bulk`. Bắn **một lần** khi record **chuyển** từ không khớp sang khớp: `record.created` (trước = không tồn tại), `record.updated` (kể cả giá trị `stored` tính lại, §5.9), `record.restored` (coi như tạo mới); record đã khớp sẵn không bắn khi sửa field khác; ra khỏi điều kiện rồi vào lại → bắn lần nữa. Không lưu trạng thái: ảnh "trước" dựng từ ảnh "sau" + `changes[].from` của event (dạng lưu trữ), field không có trong `changes` dùng giá trị hiện tại cho cả hai phía — trừ field đã bị event `record.updated` **sau** event này đổi (event được dispatch muộn): giá trị của nó tại event này là `from` của lần đổi sau đầu tiên (T527: record vừa tạo rồi được sửa thành khớp trước khi event tạo được dispatch chỉ bắn một lần, ở event sửa); đánh giá bằng quyền `run_as`; `$date` tương đối ("hôm nay") theo thời điểm event; **không** bắn khi chỉ thời gian trôi — dùng `record.date_reached`/`schedule`. Builder gợi ý `record.matches` thay tổ hợp `created` + `updated` + `changed_to` (S5, T510) |
| `button.clicked` | table_id, `field_id` (field `button`), `min_permission`: `edit` (mặc định) \| `read`, `enabled_when` (Filter DSL \| null). Chạy bằng `run_as`; `min_permission`/`enabled_when` là một phần định nghĩa (ADR-32 §2; S5, T517). Tối đa một automation chưa xoá mỗi nút. Bấm = `POST /tables/:id/records/:recordId/buttons/:fieldId/click` → `202 { run_id }`: không đọc được record/field → `404`, dưới `min_permission` → `403`, automation tắt/không có hoặc `enabled_when` AND `condition` (`changed*` = sai) không khớp bản mới nhất đọc bằng `run_as` → `422 BUTTON_DISABLED`; 10 lần/phút mỗi (nút, user), 1 lần/2 s mỗi (nút, record, user) → `429`. Mỗi lần bấm là event `button.clicked` (`depth = 0`, đơn vị kích hoạt riêng) + run tạo ngay trong cùng transaction; dữ liệu trigger `clicked_by`, `clicked_at`; kết thúc run → `automation.run.finished` chỉ tới người bấm. Share link: không bấm được (CONTRACTS §21 "Button") |
| `approval.completed` | `flow_id`, `outcome`: `approved` \| `rejected` \| `withdrawn` \| `any` — S10, ADR-29 |

`record.date_reached` dùng chung **lõi quét thời gian** với nhắc hạn field ngày (S5b, ADR-34 §1: lõi `time-scan` tách khỏi automation — con trỏ riêng mỗi bên tiêu thụ, automation theo automation + quyền `run_as`, nhắc hạn theo field + quyền từng người nhận lúc gửi; nhắc hạn không phải automation ẩn): job `automation.date_scan` mỗi phút quét theo index của cột trong cửa sổ `(lần quét trước, now]`, khoá dedupe `automation_id:record_id:<giá trị>`. Field `virtual` không dùng được.

**Cài đặt (T508)**: `AutomationTimeTriggers` (`packages/server-core/src/automation/time`), cron worker `automation.schedule_tick` và `automation.date_scan` mỗi phút (đồng hồ tiêm được). Mỗi cron tìm automation đang bật có trigger đó ở mọi org qua `listTimeTriggerAutomations` (chỉ org id + id, §14.1), rồi xử lý **từng automation trong một transaction** theo org: khoá dòng automation + con trỏ `meta.automation_time_cursors`; cửa sổ = `(max(scanned_until, trigger_armed_at), now]` — chỉ thời điểm đi qua sau lần bật gần nhất, worker dừng thì lần sau quét tiếp từ chỗ dừng; run `queued` có `trigger_key` (dedupe), không event (`depth` 0), job `automation.run` và con trỏ dời trong cùng transaction. `schedule`: parse cron trong repo (`time/cron.ts`, không dependency — 5 trường, `*`, số, `a-b`, `*/n`, `a-b/n`, danh sách, tên `JAN`/`MON`, ngày-tháng và thứ cùng hạn chế → khớp một trong hai), giờ tường theo timezone (null = của org) đổi sang thời điểm bằng tz data của runtime (giờ bị bỏ qua khi DST tiến → bắn ở thời điểm đã dời, giờ lặp khi DST lùi → bắn một lần ở lần đầu); lần bắn gần nhất trong cửa sổ bắn **một** lần (`fired_at`), các lần trước đó (worker dừng) chỉ đếm vào `input.trigger.missed`. `record.date_reached`: thời điểm = giá trị + `offset_minutes` (field có giờ, `created_at`, formula/lookup `stored` kiểu `datetime`), field chỉ ngày (kể cả formula `stored` kiểu `date`) = `time_of_day` (mặc định 09:00) của ngày đó theo `options.timezone` của field, không có thì timezone org (ADR-21) + offset; đọc qua `RecordQueryService.scanDue` bằng quyền `run_as` (record sống, read rule, field đọc được, `condition` của automation — `changed*` coi là sai) theo khoảng **trên chính cột** `(cửa sổ − offset)` có thứ tự `(giá trị, __id)` nên dùng index btree `<table>_<cột>_due` (`SchemaService.ensureDueIndex` tạo khi quét lần đầu, partial `__deleted_at IS NULL`; `created_at` dùng index sẵn có của `__created_at`); mỗi (record, giá trị) bắn một lần, giá trị đổi (kể cả formula `stored` tính lại) → bắn theo giá trị mới khi tới; tối đa `AUTOMATION_MAX_RUNS_PER_BATCH` run mỗi automation mỗi lần quét (phần còn lại lần quét sau, đơn vị kích hoạt `date:<cuối cửa sổ>`). Đo: 200.000 dòng có index, cửa sổ 1 phút ≈ 16 ms (máy dev đang tải cao). Chi tiết: C§21 "Trigger thời gian".

**Lõi quét dùng chung (T546, ADR-34 §1)**: phần chung của bộ quét trên nằm ở `packages/server-core/src/time-scan` — `due.ts` (quy tắc đến hạn, `automation/time/due.ts` chỉ re-export), `dueRuleOf` (loại giá trị + timezone field → org → mặc định instance), kho con trỏ là interface `TimeScanCursorStore` (`lock(scope, key, now)` khoá và trả `{ scanned_until, armed_at }`, `advance`), cửa sổ `windowOf`/`openWindow` = `(max(scanned_until, armed_at), now]`, `TimeScanCore.scan` (đọc `RecordQueryService.scanDue` phân trang `(giá trị, __id)` bằng `access` + `filter` của bên tiêu thụ, lọc đúng cửa sổ bằng `dueAt`, gọi `onDue(tx, record, due)` trong transaction của bên tiêu thụ — trả `true` khi tạo được gì, bản trùng không tính vào trần `maxHits`; kết quả `done | capped | unavailable` + mốc dời con trỏ: cuối cửa sổ, hoặc `due − 1 ms` khi chạm trần; `resumeAfter = { due, id }` tuỳ chọn (T560, QA S5b M7): lần quét tiếp của một lần chạm trần đọc một dòng dò, nếu dòng đầu cửa sổ tới hạn đúng `due` thì phân trang tiếp từ `(giá trị đó, id)` — không đọc lại các record cùng thời điểm đã xử lý (bên tiêu thụ automation không dùng, chống trùng bằng `trigger_key`); `404`/`INVALID_FILTER` của bộ đọc → `unavailable`, coi cửa sổ đã xử lý; lỗi khác ném ra để transaction rollback) và `ensureIndex` (một lần mỗi field mỗi process). `AutomationTimeTriggers` là bên tiêu thụ automation (kho `automation_time_cursors`, quyền `run_as`, `condition`, một run mỗi lần trúng) — hành vi T508 giữ nguyên. Ngữ cảnh **quét hệ thống** `RecordQueryService.systemScanAccess(scope, table, fieldIds)` (1–10 field): chỉ `scanDue` nhận (đọc khác → lỗi lập trình), record sống ngoài thùng rác của một table còn sống trong org, **chỉ** các field nêu (field khác như field không đọc được: `INVALID_FILTER`/`422`), không read rule; `scanDue` nhận thêm `fields` để trả ô JSON của các field đó (người nhận của nhắc hạn). Chỉ code worker gọi: test khoá chỉ `time-scan/**` và `notifications/reminders/**` (ngoài chính `records`) nêu tên nó, không export ra gói. **Bên tiêu thụ nhắc hạn (T547, C§22.6)**: `DateReminderScanner` (`packages/server-core/src/notifications/reminders`), cron `notifications.date_reminder_scan` mỗi phút: `listDateReminderFields` → mỗi field một transaction — khoá `meta.date_reminder_cursors` (không có dòng = nhắc tắt), `dueRuleOf` với `offset_minutes`/`time_of_day` của `reminder`, `systemScanAccess(table, [field ngày, field người nhận?])` + `scanDue` `fields`, mỗi record tới hạn một `enqueueNotification` `date.reminder` (`group_key = <fld>:<rec>:<giá trị>`, người nhận = user của field lúc quét hoặc `user_ids`, quyền kiểm từng người ở `notifications.fanout`), một field quét lỗi (timeout, lỗi DB) không chặn các field sau của mọi org — kết quả `error` + `code`, con trỏ giữ nguyên, lần sau thử lại (QA T559 H2); trần 1.000 nhắc/field/lần quét với ranh giới keyset `boundary_*` (thời điểm + record cuối đã nhắc, chuyển cho lõi qua `resumeAfter`) để nhiều record cùng thời điểm vẫn tiến, mỗi lần quét đọc ≈ trần dòng; dời con trỏ cùng transaction. Bench opt-in (`DATE_REMINDER_BENCH=1`, 20 field × 200k dòng, cửa sổ 1 phút mỗi field): trung vị 268 ms một lượt quét (máy dev 8 CPU, load 17), mục tiêu < 2 s. Đo (`AUTOMATION_BENCH=1`, 200k, trung vị 5 cửa sổ 1 ngày, máy dev 8 CPU dùng chung với nhiều luồng agent): main 342–1.471 ms, T546 687–4.317 ms tuỳ tải (load lúc bắt đầu 3–5, lúc kết thúc 3–113); cặp chạy liền nhau main/T546 1.471/1.226 ms; thời gian chủ yếu là ghi run (`onDue`, cùng code T508), phần đọc là cùng câu SQL `scanDue` — chưa đủ điều kiện máy để kết luận mức ±10 % (đo lại ở T557 trên máy rảnh). **T557** đo lại A/B trên máy rảnh (load 1 phút lúc bắt đầu 2,5–3,6, mọi lần < 4; `-t date_reached`, mỗi lần seed 200k riêng, xen kẽ A/B ba cặp): main trước T546 (`ef72a2ff`) trung vị 389 / 391 / 390 ms, code hiện tại 356 / 409 / 386 ms — trung bình 390 so với 384 ms (nhanh hơn 1,5 %; lần chậm nhất 409 ms so với lần nhanh nhất của main 389 ms là +5 %), trong ngưỡng 10 %: không cần task sửa.

Phase 2: trigger "cả lô" (một run cho một `batch`). (`button.clicked` và `record.matches` vào S5 theo BACKLOG "Quyết định S5" #5, #7; `webhook.received` thuộc gói webhook/HTTP S5c.) Định nghĩa, API quản lý và `run_as`: CONTRACTS §21.

### 11.3 Condition

Filter DSL (§6) evaluate trên record **sau** thay đổi, cộng thêm operator chỉ dành cho automation:
- `changed` — field thuộc diff của event.
- `changed_to` — field đổi và giá trị mới = value.
- `changed_from` — field đổi và giá trị cũ = value.

> Lỗi của bản 0.1: condition `status equals DONE` trên `record.updated` sẽ bắn lại **mỗi lần** record DONE bị sửa bất kỳ field nào. Automation "khi chuyển sang DONE" MUST dùng `changed_to`.

**Bước điều kiện một cấp** (action `if`, §11.5): giữa chuỗi action, rẽ hai nhánh `then` / `else`. Điều kiện gồm:
- điều kiện Filter DSL trên record trigger (đọc lại bản mới nhất);
- điều kiện trên giá trị (§11.4): `{ "value": <giá trị>, "operator": "is" | "is_not" | "contains" | "is_empty" | "is_not_empty" | "gt" | "gte" | "lt" | "lte", "compare": <giá trị> }`.

Nối các điều kiện bằng `and`/`or` một tầng. Trong `then`/`else` không có `if` lồng. Chạy xong nhánh thì tiếp tục các action sau `if`. `on_false`: `else` (mặc định, chạy nhánh `else`, có thể rỗng) hoặc `stop` (kết thúc run với status `succeeded`, dùng cho "chỉ tiếp tục nếu"). Tổng action, kể cả trong nhánh, ≤ 20.

### 11.4 Giá trị trong action config

Mỗi giá trị là một trong:
- literal: `{ "literal": "abc" }`
- field của record trigger: `{ "field": "fld_x" }`
- output bước trước: `{ "step": "act_1", "path": "body.id" }`
- dữ liệu của trigger (trigger không có record hoặc có dữ liệu riêng): `{ "trigger": "<phần>", "path": "customer.email" }`. Phần theo loại trigger:

  | Trigger | Phần |
  |---|---|
  | `webhook.received` | `body` (JSON đã parse), `headers` (tên viết thường), `query` |
  | `schedule` | `fired_at` |
  | `record.date_reached` | `due_at` |
  | `record.created`/`updated`/`deleted`/`matches`, `form.submitted` | `actor` (T521b: id user gây ra event, `null` khi do hệ thống/automation) |
  | `approval.completed` | `approval` (`outcome`, `requester_id`, `instance_id`) |

  `path` dùng dấu chấm và `[n]` cho phần tử mảng (vd `items[0].sku`). Không có giá trị → `null`. Header nhạy cảm không bao giờ đọc được — danh sách `INCOMING_WEBHOOK_SENSITIVE_HEADERS` (C§25.2): `authorization`, `proxy-authorization`, `cookie`, `webhook-signature`, `x-cellhive-causation`, `x-telegram-bot-api-secret-token` — luôn `null`, kể cả khi dòng cũ có lưu (T604). `webhook.received` đọc dòng `meta.incoming_webhook_requests` của run (chỉ khi một giá trị/placeholder cần; tên header so khớp chữ thường); dòng đã dọn (> 7 ngày, vd chạy lại run cũ) → bước `failed` `trigger_data_expired`.
- template: `{ "template": "Ticket {{ [fld_title] }} đã xong, tổng {{ TEXT([fld_amount], \"#,##0\") }}đ" }` — phần trong `{{ }}` là biểu thức formula engine (§9.2) trên record trigger, **lưu dạng ID** (`[fld_…]`, canonical §9.2: một dấu cách trong `{{ }}`, tên hàm viết hoa), hiển thị dạng tên (chip; `renderTemplateNames`), field bị xoá/không còn đọc được → `#REF[fld_…]` khi hiển thị và `UNKNOWN_FIELD` khi lưu lại. `}}` trong chuỗi `"…"` hoặc tên `[…]` không đóng placeholder; `\{` là dấu `{` thường, `\\` là `\`. Mọi kiểu kết quả đều thành chữ như `cell_format=text` (C§2: số/ngày theo `style`, list nối `, `, record theo title, user theo tên). Kiểm khi lưu bằng quyền người lưu (`run_as`): cú pháp, tên, kiểu, **cấm** `REGEXMATCH`/`REGEXEXTRACT`/`REGEXREPLACE` (`UNSUPPORTED_FUNCTION`), **không** đọc cả bảng `[Table]` (`CROSS_TABLE_NOT_SUPPORTED` — dùng `find_records` + `digest`), trigger không có record chỉ dùng hằng, `NOW()`, `TODAY()`, dữ liệu trigger và record của bước trước (T505, dưới đây). Lúc chạy (T504, `packages/server-core/src/automation/values`): đọc record bằng `RecordQueryService` với quyền `run_as` lúc đó; field không còn đọc được → rỗng + cảnh báo `unknown_reference` trong output step; worker kiểm lại `REGEX*` trước khi evaluate → step `failed` `unsupported_function`; mỗi lần render ≤ 100 ms (quá → cắt, `render_timeout`); escape theo ngữ cảnh (`plain`, `header`, `telegram_html`; thân email đi qua `packages/markdown` "parse trước, thay sau"); trần độ dài theo nơi dùng (subject 255, Telegram 4.096, thông báo 200/2.000).
- **dữ liệu trigger và record của bước trước trong template** (T505, quyết định người review mở rộng T504): ngoài field của record, biểu thức trong `{{ }}` đọc được các tham chiếu ảo, **lưu theo ID** như field (cú pháp `[…]` của formula §9.2, parser nhận thêm ID `@…`/`act_…` — `isTemplateReferenceId`):
  - `[@id]`, `[@url]` trên **mọi** record (record trigger, record qua link, record của bước): id và link mở record trong web (`PUBLIC_URL/b/<base>/t/<table>?record=<id>`);
  - dữ liệu trigger trên dòng trigger: `[@fired_at]` (mọi trigger: thời điểm event/lần bắn), `[@due_at]` (`record.date_reached`), `[@clicked_by]`, `[@clicked_at]` (`button.clicked`), `[@actor]` (T521b: `record.*`, `form.submitted` — người dùng gây ra event, rỗng khi do hệ thống hoặc automation; tên lấy theo thành viên org còn hoạt động); trigger không có record (`schedule`) vẫn dùng được;
  - dữ liệu webhook (T604, chỉ `webhook.received`): `[@body]` (cả body thành chữ JSON), `[@body.<path>]`, `[@headers.<tên>]`, `[@query.<path>]` — `<path>` cú pháp như `path` ở trên, `]` trong `[…]` viết `\]` (`[@body.items[0\].sku]`; dạng lưu giữ escape). Kết quả là chữ: chuỗi giữ nguyên, số/boolean như JSON, đối tượng/mảng thành chữ JSON, không có → rỗng; header nhạy cảm luôn rỗng. ID mở (không liệt kê trước được như `[@fired_at]`) nên snapshot kiểm/chạy thêm một field chữ cho mỗi tham chiếu có trong template;
  - `[@previous]` (T521b, chỉ `record.updated`): record trigger **trước lần sửa** — link một record tới table trigger, `{{ [@previous].[fld_…] }}` = giá trị `from` trong `changes` của event (dạng lưu trữ đổi sang dạng đọc: option theo tên, user/record theo id) với field có trong `changes`, giá trị hiện tại với field khác; `[@previous].[@id]`/`[@url]` là của record trigger; field `run_as` không đọc được → rỗng như field thường;
  - record của một bước `create_record` / `update_record` / `find_records` (**bản ghi đầu tiên**) **đứng trước**: `[act_…]` là một link **một record** tới table của bước — `{{ [act_1].[fld_…] }}`, `{{ [act_1].[@url] }}`, `{{ [act_1] }}` (title), đi tiếp qua link như link thường. Kiểu kết quả là kiểu của field (không phải danh sách).
  Kiểm khi lưu như phần còn lại của template (quyền người lưu): bước phải đứng trước (bước sau, bước không có record, bước trên table không đọc được → `UNKNOWN_FIELD`), field của record bước phải đọc được, tham chiếu trigger phải có ở loại trigger đó. Lúc chạy: record bước được **đọc lại** qua `RecordQueryService` với quyền `run_as` lúc đó (field mất quyền → rỗng + `unknown_reference`), bước chưa chạy (nhánh `if` khác) hoặc `find_records` không thấy gì → rỗng. `digest.row_template` chỉ có `[@id]`/`[@url]` của từng record. Builder kiểm bằng `validate-template` với `trigger_type` + `steps` (C§21).
- danh sách (digest) từ kết quả `find_records`: `{ "digest": { "step": "act_1", "row_template": "- {{ [fld_title] }}: {{ [fld_status] }}", "max_rows": 50, "separator": "\n" } }`. `row_template` được evaluate cho từng record (chỉ các field step trả về — `fields`, rỗng = primary field; link đi tiếp được). Vượt `max_rows` (≤ 200) → thêm dòng "… và N record khác" (i18n theo locale org). Không có record → chuỗi rỗng.

Không có template engine nào khác (không Handlebars helper, không JS).

**Lấy request mẫu cho builder**: bấm "Nghe request mẫu" trên incoming webhook → trong 3 phút, request hợp lệ đầu tiên được lưu vào `incoming_webhooks.sample` (body ≤ 64 KB, header đã bỏ các header nhạy cảm ở trên). Builder dùng mẫu này để gợi ý `path`. Request đó vẫn được xử lý bình thường. API, quyền (chỉ base admin), cắt body > 64 KB thành chuỗi + `truncated`, envelope `incoming_webhook.sample_captured` tới người nghe: C§25.3 (T603).

### 11.5 Actions (MVP)

| Action | Ghi chú |
|---|---|
| `create_record` | table trong cùng base, map field |
| `update_record` | record trigger hoặc record id từ bước trước |
| `update_records` | Sửa hàng loạt theo filter: `table_id`, `filter` (Filter DSL, value có thể là giá trị §11.4), map field, `limit` (mặc định 1.000, tối đa 10.000). Đếm trước; vượt `limit` → step `failed` (`too_many_records`) mà không ghi gì. Ghi theo lô ≤ 1.000 với `batch_id = run_…` (ADR-26). Chỉ record `run_as` sửa được (read rule **và** edit rule; record đọc được nhưng không sửa được bị bỏ qua và đếm vào `skipped_not_editable` của output); `value` của điều kiện trong `filter` có thể là cả một giá trị §11.4 (T506) |
| `find_records` | `table_id`, `filter`, `sort`, `fields`, `limit` (≤ 200). Đọc qua `RecordQueryService` với quyền `run_as`. Output `{ records: [{ id, fields }], count, truncated }` (field theo id, giá trị dạng json). Dùng cho `{ "step" }`, `digest`, điều kiện `if` |
| `delete_record` | chỉ record trigger; UI cảnh báo |
| `if` | Bước điều kiện một cấp (§11.3) |
| `http_request` | T606 (C§21 "http_request", ADR-35 §4, §5, §8): `method`, `url`, `query`, `headers`, `auth` (tên header + secret `http_header` của org trong phạm vi base), `body` (`json` / `form` / `text`), `signing_secret_id` (secret `webhook_signing` — chữ ký Standard Webhooks, hai chữ ký trong 24 h sau khi đổi secret), `fail_on_http_error`. Kiểm khi lưu bằng quyền người lưu (field/template đọc được, header outbox tự đặt hoặc của kết nối → `HEADER_NOT_ALLOWED`, URL literal sai → `INVALID_URL`, secret → `SECRET_NOT_USABLE`). Render bằng `run_as` lúc chạy (giá trị trong template URL mã hoá như `encodeURIComponent`, body JSON escape như chuỗi JSON rồi phải parse được, header một dòng ASCII, body ≤ 1 MiB) rồi **giao qua outbox hai pha** (§11.7, C§25.5 — bước/run `waiting`, không gọi mạng trong bước): chịu SSRF policy §14.3; timeout 10s; response ≤ 1 MB; 6 lần thử + `Retry-After`; lưu status + body (cắt 10 KB) vào step output dùng được ở bước sau (`{ "step", "path": "body.id" }`); gửi token causation (ADR-27, §13.3). Gửi thử từ builder: bằng quyền người gọi, qua outbox (dòng `test`), 10 lần/phút/người; trigger `webhook.received` đọc **mẫu đã nghe** của hook (chỉ base admin; không có mẫu → giá trị rỗng + cảnh báo `no_sample`) (C§25.5, T616) |
| `run_n8n_workflow` | T607 (C§21 "run_n8n_workflow", ADR-35 §4): preset của `http_request` — `url`, `signing_secret_id` (**bắt buộc**, secret `webhook_signing` — chữ ký Standard Webhooks), `fields` (≤ 100 field của table trigger, `null` = mọi field `run_as` đọc được), `include_changes`. `POST` JSON payload chuẩn §13.3 dựng **lúc chạy** bằng quyền `run_as` lúc đó qua `RecordQueryService`: field không đọc được không có key, record liên kết không đọc được `title = null`, trigger không record (`schedule`, `webhook.received`) hoặc record không đọc được → `record: null`, `changes` (chỉ `record.updated`) chỉ field gửi đi; payload > 1 MiB → `failed` `http_request_too_large`. Kiểm khi lưu, giao qua outbox (§11.7), header, thử lại như `http_request`; body response luôn ẩn trong lịch sử chạy. Gửi thử như `http_request` (T616): payload dựng bằng quyền **người gọi** trên record mẫu, `automation.run_id = ""`, `event.id = null` (C§25.5) |
| `send_email` | Gửi qua SMTP **cấp instance** (`SMTP_URL`/`SMTP_FROM`, §20) hoặc SMTP riêng của **danh tính gửi** đã xác minh (ADR-33, T530) — không còn "SMTP cấu hình theo org" (BACKLOG Quyết định S5 #1; SMTP cấp org = P1). Mọi thư qua một `Mailer.send` dùng chung (T513, C§23): TLS bắt buộc, header bắt buộc, giới hạn `EMAIL_*`, phân loại lỗi `smtp_temporary`/`smtp_rejected`. to/cc/bcc từ literal, field email, field user, bước trước, `clicked_by`; Reply-To chỉ danh tính đã xác minh hoặc user Cellhive; body Markdown hẹp nhận `digest` (`{{ [@digest] }}`); không kiểm quyền đọc của người nhận (cảnh báo ở builder); xem trước theo quyền người sửa + gửi thử chỉ tới chính mình (T514, C§21 "send_email"); đính kèm tệp từ ≤ 5 field attachment của record trigger (`run_as` phải tải được — `file_download_fields`; chỉ tệp `ready`, `pending_scan` → `failed` hoặc `skip`; chặn đuôi Gmail + HTML/SVG; trần `min(EMAIL_MAX_*, cài đặt org)` kiểm trước khi đọc, vượt → `failed`; đọc stream từ storage vào thư) (T532); ảnh nhúng **chỉ CID** (phần `inline` + `Content-ID`, HTML `<img src="cid:…">`, không URL từ xa/`data:`/URL ký): logo chữ ký (≤ 2, ảnh org upload), ảnh thân thư upload cho automation (`![alt](asset:…)`) và ảnh field attachment của record trigger (`![alt](field:…)`, thumbnail 1280 px mã hoá lại JPEG/PNG (Outlook không hiển thị WebP), chỉ tệp `ready` mà `run_as` tải được, không thì bỏ ảnh + cảnh báo); giá trị record không bao giờ tạo ảnh; ≤ `EMAIL_MAX_INLINE_IMAGES` ảnh/thư, byte tính chung trần đính kèm; bản text `[alt]` (T534, C§23.5) |
| `send_notification` | Thông báo trong app loại `automation.message` (ADR-32 §1, T515, C§21 "send_notification"): người nhận từ field user của record trigger, user cố định, group (bung lúc gửi), bước trước, `clicked_by` — ≤ 100 người sau khi bung, vượt → step `failed`; title (một dòng ≤ 200) + body (plain text ≤ 2.000) là template trên record trigger/dữ liệu trigger/record của `create_record`/`update_record` trước đó (không `find_records`/`digest`); chỉ giao cho người đọc được record được link **và mọi field** nội dung dùng, người khác bị bỏ và ghi id + lý do vào output bước; render một lần mỗi nhóm hồ sơ quyền bằng quyền nhóm đó (không bằng `run_as`); trần 100 tin/giờ/người nhận → một thông báo tóm tắt; email theo tuỳ chọn người nhận (T512) |
| `send_telegram` | Bot của org (token trong `meta.secrets`, chọn theo tên; base phải nằm trong phạm vi của secret — T516, C§21 "send_telegram", C§24); `chat_id` literal/field/bước trước; text là template Telegram HTML (`parse_mode=HTML`, giá trị escape HTML từng giá trị, ≤ 4.096 ký tự — cắt thì đóng thẻ đang mở), nhận `digest` (`{{ [@digest] }}`); host cố định `api.telegram.org`, timeout 10 s, tối đa 25 tin/giây mỗi bot (cửa sổ trượt, bucket Valkey theo id bot, **dùng chung** với thông báo qua Telegram — T550, C§22.4), `429` thử lại sau `retry_after`, 4xx khác → `failed` ngay; secret bị xoá/đổi phạm vi bỏ base → `failed` `secret_unavailable` (automation không tắt); output chỉ `message_id`, không lưu text |
| `delay` | 1 phút – 30 ngày (`minutes`), hoặc tới thời điểm của một giá trị §11.4 (`until`, ≤ 30 ngày tới; đã qua → không chờ); option `recheck_condition` (filter DSL): hết delay đọc lại record, không khớp thì dừng run với status `skipped` (dùng cho SLA); record trigger bị xoá trong lúc chờ → `skipped` (`record_deleted`; trigger `record.deleted` không kiểm điều này, điều kiện kiểm lại đọc record trong thùng rác). Run `waiting` không giữ worker/chỗ trần org, không tính vào timeout; tắt/xoá automation → run đang chờ `cancelled` (T506, C§21) |
| `ai_classify` / `ai_fill_field` | Sprint AI (§12); output ghi vào field select/text |
| `start_approval` | S10 (ADR-29): `flow_id`, `requester` (mặc định `run_as`, hoặc `{ "field" }`) |

Phase 2: nhánh nhiều cấp/switch, loop/iterate trên `find_records`, run sub-workflow, sandbox script, nút hành động trong tin nhắn (link có ký).

Giới hạn: tối đa 20 action/automation (tính cả action trong nhánh `if`).

### 11.6 Loop guard (bắt buộc — bản 0.1 thiếu)

- Mọi event có `causation`: `{ "root_event_id", "depth", "automation_chain": [automation_id,…] }`. Mutation do người dùng: depth 0.
- Mutation do automation tạo ra event với `depth = parent.depth + 1` và nối `automation_id` vào chain.
- Giá trị computed tính lại (§5.9, T509) giữ `causation` của lần ghi gây ra nó, depth **không** tăng; qua hàng đợi `meta.computed_recompute_queue.causation` gộp bảo thủ (`depth` lớn nhất, chain hợp — có thể dài hơn depth, tối đa 64 id), nên A sửa X → F tính lại qua job → A không chạy lại.
- Không kích hoạt nếu `depth >= 3` (cấu hình org `settings.automation_max_depth`, 1–5, T503) hoặc automation đã có trong chain (không tự kích hoạt lại chính nó).
- Qua HTTP (ADR-27): `http_request`/`run_n8n_workflow` gửi header `X-Cellhive-Causation` (token AES-256-GCM, gắn **chính instance** — host `PUBLIC_URL` + tiền tố `/api/v1/hooks`, không phải URL đích (T616, Sửa đổi ADR-27 §5) — hết hạn 1h). `/hooks/:token` giải mã được (host `PUBLIC_URL` hoặc `Host` sau `TRUSTED_PROXIES`, path request dưới `/api/v1/hooks`) → event `webhook.received` nối tiếp `depth`/chain thay vì depth 0 — kể cả khi header được n8n/hệ ngoài chuyển tiếp. Token sai → bỏ qua header (depth 0). Một bước qua hook tính **một** mức như một lần ghi record (Sửa đổi 2026-10-25 của ADR-27): token mang depth của run gửi (chain có automation gửi), hook cộng 1 — người (0) → A → hook (1) → B → record (2).
- Circuit breaker (ADR-26), đếm theo **đơn vị kích hoạt** (`trigger_unit`): `batch.id` với event hàng loạt (gồm event tính lại của một lần chạy `computed.recompute`: cả lần chạy là một đơn vị), còn lại `root_event_id`; lần bắn với `schedule`; `webhook.received`: request có causation hợp lệ (ADR-27) → `root_event_id` như event nội bộ, không có → **cửa sổ 1 giây mỗi hook** `webhook:<hok>:<giây epoch>` (ADR-35 §5 sửa ADR-26 §5 "từng request": một hook ≤ 60 đơn vị/phút nên nhịp mặc định 5 req/s không tự tắt automation; vòng lặp vẫn bị chặn bởi `depth`, bucket của hook và luật thất bại liên tiếp — T604). Một automation có > 100 đơn vị khác nhau/phút, hoặc 50 đơn vị liên tiếp thất bại (có run `failed`, không có run `succeeded`) → tự `enabled=false`, `disabled_reason = circuit_breaker`, báo `run_as` + owner/admin base (qua thông báo S5b; trước S5b: danh sách automation + email nếu có SMTP).
- Trần fan-out (ADR-26): tối đa `AUTOMATION_MAX_RUNS_PER_BATCH` (mặc định 1.000) run cho mỗi automation mỗi `batch.id`. Phần vượt không tạo run; một run đại diện `skipped` với `error.code = batch_fanout_exceeded` ghi số bị bỏ; automation không bị tắt.

### 11.7 Độ tin cậy

- At-least-once + idempotency. `idempotency_key = automation_id:trigger_event_id:action_id`. Nếu step với key đã `succeeded` → bỏ qua.
- `update_records` chạy theo thứ tự `__id` và ghi tiến độ (`last_record_id`, số đã ghi) vào output của step sau mỗi lô; retry tiếp tục từ lô chưa xong, không ghi lại lô đã commit.
- `http_request`/`run_n8n_workflow` gửi header `Idempotency-Key` và `webhook-id` (Standard Webhooks, §13.3).
- **Bước HTTP (T605, ADR-35 §4, C§25.5)**: không gọi mạng trong transaction của bước — handler trả request, engine chèn dòng `meta.http_deliveries` + job `http.deliver`, bước `waiting` và run `waiting` như `delay` (không giữ chỗ trần org, không tính 15 phút); job nhận lease (30 s), commit, xin lượt `HostPacer`, gọi qua lõi §14.3, rồi ghi kết quả + đánh thức run trong transaction khác. Thử lại là của **dòng giao**, không phải của bước: 6 lần (ngay, 10 s, 1 phút, 5 phút, 15 phút, 30 phút ±20 %), lỗi tạm = mạng, timeout, 408/425/429/5xx trừ 501; `Retry-After` ≤ 1 h tôn trọng và tạm dừng cả (org, host), > 1 h → `rate_limited`; hết lượt/lỗi vĩnh viễn → bước + run `failed` (DLQ = "chạy lại"). Huỷ run/tắt automation huỷ dòng `pending`.
- Retry: 5 lần, exponential backoff (10s, 30s, 2m, 10m, 30m) với jitter; chỉ retry lỗi mạng, timeout, HTTP 429/5xx (bước HTTP: lịch riêng của outbox ở trên).
- Timeout toàn run 15 phút (không tính delay).
- Concurrency (ADR-18): job `automation.run` **không** đặt `queue_name` (named queue của graphile-worker có concurrency = 1 → một run chậm chặn cả org). Giới hạn song song toàn worker bằng `concurrency` config; công bằng giữa các tenant bằng trần **`AUTOMATION_MAX_RUNNING_PER_ORG`** (mặc định 5): đầu job đếm `automation_runs` `status='running'` của org (khoá bằng `pg_advisory_xact_lock(hashtext('automation-org:' || org_id))`), vượt trần → tự lên lịch lại với `run_at = now() + 5s + jitter` (không tính là lần retry). Chi tiết ADR-18. Named queue chỉ dùng cho tác vụ cần tuần tự với cardinality thấp: `schema:<tableId>` (DDL, compaction, backfill).
- Worker restart không mất job (job nằm trong Postgres).
- **Cài đặt (T505)**: retry là của **bước** (`automation_run_steps.attempt`): lỗi tạm (`AppError` `429`/`5xx`/`SCHEMA_LOCKED`, SQLSTATE `55P03`/`40P01`/`40001`/`57014`/`08…`, lỗi mạng/timeout, `AutomationStepError` có `transient`) → bước `failed` với `retry_at`, run về `queued`, job `automation.run` được thêm lại với `run_at = retry_at` (jitter ≤ 20 %); lần thử thứ 6 vẫn lỗi → run `failed` `temporary_error` (`params.attempts`). Lỗi khác `failed` ngay: `invalid_value` (record service trả 4xx validate), `permission_denied` (`params.scope`: `record` — ngoài rule của `run_as`, P29, automation vẫn bật; `table`/`base` — `run_as` mất quyền, gọi kiểm `run_as` của T507), `unsupported_function`, `unsupported_action`, `internal_error`. Timeout 15 phút tính **thời gian chạy** (`active_ms` + đoạn hiện tại), kiểm trước mỗi bước — thời gian chờ retry và `delay` không tính; một bước đơn lẻ đang chạy không bị ngắt giữa chừng (mỗi ghi có `statement_timeout` riêng). Trần `AUTOMATION_MAX_RUNNING_PER_ORG` đếm run `running` có `running_since` trong 15 phút gần nhất (run của worker đã chết không giữ chỗ mãi); run đang chạy tiếp sau khi worker chết không xin chỗ lại.
- **Cài đặt (T506)**: `update_records` đếm trước (tối đa `limit + 1`), rồi ghi theo lô `__id` qua `RecordQueryService.editableIds` + `RecordMutationService.update`; mỗi lô commit cùng tiến độ trong output bước (`saveProgress`), retry đọc lại tiến độ (`previous`) — không đếm lại, không ghi lại lô đã commit; ≥ 10.000 record đã ghi → `SchemaService.analyzeComputedTable` (ANALYZE, best effort). `delay`: handler trả `wait { until }` → engine đặt bước `waiting` (output `{ until }`), run `waiting` (kết thúc đoạn chạy), thêm job `automation.run` lúc `until` (job key `automation.run:wait:<run_id>`); job tới sớm → thêm lại; tới hạn → xin chỗ trần org như run `queued`, bước chạy tiếp không tăng `attempt`, handler kiểm lại record trigger + `recheck_condition` → `skip` (run + bước `skipped`, không event, không breaker) hoặc tiếp tục. Tắt/xoá automation (người, breaker, T507) gọi `cancelWaitingRuns` trong cùng transaction → run `waiting` `cancelled` (`automation_disabled` / `automation_deleted`); engine cũng huỷ run khi tiếp tục mà automation đã tắt. Hook huỷ một run cho T518: `cancelWaitingRun`.
- Định nghĩa automation có `version`; run lưu `automation_version` và snapshot definition vào `input`.
- **Lịch sử chạy (T518, C§21 "Lịch sử chạy")**: chỉ người quản lý được automation xem run (người khác `404` — run chứa dữ liệu record); output bước lọc theo quyền **hiện tại** của người xem (field không đọc được, record ngoài read rule → `null` + `redacted`). **Chạy lại** run `failed`/`cancelled` = run **mới** với định nghĩa và `version` **hiện tại** (Quyết định S5 thiết kế #4), trigger của run gốc, `rerun_of`; bước đã `succeeded` ở run gốc và vẫn là cùng action (id, loại, table) được chép sang `succeeded` (khoá idempotency của run mới) nên không lặp side effect; tối đa một lần chạy lại chưa xong mỗi run. **Huỷ** run `queued`/`waiting` → `cancelled` (`cancelled_by_user`), bước `waiting` (delay T506) cũng `cancelled`; job đã lên lịch thấy run không còn `queued` nên không làm gì. **Thời hạn lưu**: cron `automation.runs_cleanup` (hằng ngày 02:45 UTC) xoá run đã kết thúc cũ hơn `AUTOMATION_RUN_RETENTION_DAYS` (mặc định 90) theo lô theo org; run `queued`/`running`/`waiting` giữ nguyên.

### 11.8 Ví dụ JSON

```json
{
  "name": "Báo Telegram khi ticket xong",
  "trigger": { "type": "record.updated", "table_id": "tbl_tickets", "watch_fields": ["fld_status"] },
  "condition": { "op": "and", "items": [
    { "field": "fld_status", "operator": "changed_to", "value": "opt_done" }
  ]},
  "actions": [
    { "id": "act_1", "type": "send_telegram", "config": {
      "secret_id": "sec_bot",
      "chat_id": { "literal": "-100123456" },
      "text": { "template": "✅ {{ [fld_title] }} — phụ trách: {{ [fld_assignee] }}" }
    }}
  ]
}
```

Dùng record của bước trước và dữ liệu trigger (T505):

```json
{
  "trigger": { "type": "record.created", "table_id": "tbl_orders" },
  "actions": [
    { "id": "act_1", "type": "create_record", "config": {
      "table_id": "tbl_invoices",
      "fields": { "fld_inv_title": { "template": "HĐ cho {{ [fld_title] }}" } }
    }},
    { "id": "act_2", "type": "update_record", "config": {
      "table_id": "tbl_orders", "record_id": null,
      "fields": { "fld_note": { "template": "Hoá đơn {{ [act_1].[fld_inv_no] }}: {{ [act_1].[@url] }} (lúc {{ TEXT([@fired_at], \"HH:mm\") }})" } }
    }}
  ]
}
```

---

## 12. AI

### 12.1 Nguyên tắc
- Provider cấu hình theo org: `base_url` OpenAI-compatible (dùng được OpenAI, Anthropic qua gateway, vLLM/Ollama local), `model`, API key trong `meta.secrets`.
- AI là tuỳ chọn: không cấu hình provider thì mọi UI AI ẩn đi, hệ thống vẫn đầy đủ chức năng. Không có provider "mặc định" nào gửi dữ liệu ra ngoài.
- `allow_record_data=false` (mặc định) → AI chỉ được thấy **schema** (tên table/field/kiểu/options), không thấy dữ liệu record. Bật lên phải do org admin, ghi audit. Lý do: tuân thủ quy định bảo vệ dữ liệu cá nhân khi dùng LLM bên ngoài.
- AI **MUST NOT** sinh SQL. Output luôn là JSON theo zod schema (Filter DSL, aggregate query, automation definition, formula string) → validate → chạy qua query engine với quyền của **user đang hỏi**.
- Chỉ gửi field user có quyền đọc. Mọi request AI ghi audit (không lưu prompt chứa dữ liệu nếu org tắt).
- Giới hạn token/ngày theo org.

### 12.2 Tính năng MVP (Sprint AI)
1. **AI formula**: mô tả → formula string → chạy typecheck của engine; lỗi thì gửi lại lỗi cho model tối đa 2 lần.
2. **AI automation builder**: câu tiếng Việt → automation JSON (`enabled=false`) → UI hiển thị dạng visual để user xác nhận rồi mới bật. Không bao giờ tự bật.
3. **AI Q&A trên table**: câu hỏi → aggregate query JSON (§10 format) → chạy → trả kết quả số + LLM diễn giải (chỉ gửi kết quả đã tổng hợp, không gửi dòng thô trừ khi `allow_record_data`).
4. **Action `ai_classify` / `ai_fill_field`** trong automation (cần `allow_record_data`).

Phase 2: AI analyze table tự do, extract từ file đính kèm, summarize nhiều record.

---

## 13. API, webhook, n8n

### 13.1 REST
- Prefix `/api/v1`, JSON, lỗi theo RFC 9457 (problem+json) với `code` ổn định.
- OpenAPI 3.1 sinh từ zod, phục vụ công khai tại `/api/v1/openapi.json`. Trang UI tài liệu (`/api/docs`, tự host, không CDN) để Phase 2. `/metrics` (§19) và `/api/v1/storage/local/*` (URL ký của driver local, §16) không nằm trong OpenAPI.
- Record API (tham khảo Airtable, Teable, Lark):
  - `field_key_type`: `name` (mặc định, giống Lark/Airtable/Teable) | `id` (khuyến nghị cho tích hợp lâu dài vì tên có thể đổi).
  - `cell_format`: `json` (mặc định, giá trị có cấu trúc) | `text` (chuỗi hiển thị đã format theo locale).
  - `typecast`: `false` mặc định; `true` → chuyển đổi best-effort từ chuỗi (số, ngày, tên option, email user); option chưa có sẽ được tạo nếu role có quyền sửa option, nếu không → lỗi `INVALID_SELECT_OPTION`.
  - Upsert: `PATCH /records` với `upsert: { "merge_on": ["fld_code"] }` (giống `performUpsert.fieldsToMergeOn` của Airtable) — khớp theo 1–3 field; khớp nhiều record → lỗi.
  - Filter trong API nhận **hai dạng**: object DSL (§6) hoặc dạng tuple ngắn giống Lark `{ "logic": "and", "conditions": [["Trạng thái","intersects",["Done"]]] }` — server chuẩn hoá về DSL (bảng ánh xạ ở `CONTRACTS.md` §3).
  - Lịch sử record: `GET /tables/:id/records/:recordId/history` (từ audit log, giống record history của Lark; lọc `?field=` cho lịch sử từng ô), `POST …/revert` khôi phục giá trị cũ, thùng rác `GET /tables/:id/records/trash` (§14.4, ADR-23).
  - Định dạng giá trị từng type: `CONTRACTS.md` §2.
- Phân trang offset/limit; response có `total`.
- Auth: cookie session (web) hoặc `Authorization: Bearer <api_token>`. Token có scopes: `records:read`, `records:write`, `schema:read`, `schema:write`, `automations:write`, giới hạn theo base (tuỳ chọn). Token hiển thị một lần, lưu hash SHA-256, có prefix để nhận diện (`cht_…`, chốt ở ADR-37 §2).
  - S6 (ADR-36 §1, thắng dòng trên khi khác): định dạng `cht_` + 30 base62 + CRC32 6 ký tự; thêm scope `automations:read`; mỗi route khai báo scope hoặc "chỉ session" (C§26.3); quyền = quyền hiện tại của user ∩ scope ∩ `base_ids` ∩ org của token; Bearer thắng cookie, không CSRF; ghi mang actor = user + `via.api_token_id`. Route OIDC là `GET /auth/oidc/:provider/start|callback` (ADR-36 §3).
  - Xác thực (T704, ADR-36 §1): chỉ `AuthGuard` (`apps/api/src/common/auth/**`) đọc `Authorization` của request HTTP (bắt tay WS: `RealtimeGateway` đọc header rồi gọi cùng resolver `bearerTokenOf` + `ApiTokenAuthService` của `common/auth` — ADR-36 §2, C§26.5); route không `@Public()` có header này → chỉ xác thực bằng header (không đọc cookie, không CSRF): `parseApiToken` (sai định dạng/checksum → `401` không chạm DB) → SHA-256 → `findApiTokenByHash` → một truy vấn trong scope org (token, user, `settings`, membership) → `401 TOKEN_REVOKED` / `TOKEN_EXPIRED` / `UNAUTHENTICATED` (org tắt token, user không `active`, không còn là member, scheme khác `Bearer`), mọi `401` kèm `WWW-Authenticate: Bearer error="invalid_token"`; route `@Public()` bỏ qua header. Sau đó `ScopeGuard` tra bảng route → scope (C§26.3, `packages/contracts/src/api-token-scopes.ts`, theo `operationId`, route không có trong bảng = chỉ session): thiếu scope / route chỉ session → `403 INSUFFICIENT_SCOPE` (`errors[0].params.required`), trừ khi route nêu tài nguyên token không với tới → `404`. `AccessService` giới hạn membership vào org của token và base vào `base_ids` (danh sách base/workspace chỉ trả base trong `base_ids`). `last_used_at` ghi ≤ 1 lần/5 phút (`UPDATE … WHERE last_used_at IS NULL OR last_used_at < now() - interval '5 minutes'`, lỗi chỉ log). Rate limit và `Idempotency-Key` theo khoá `tok_…` (session: `usr_…`). Bearer sai: ≤ 300 lần/phút/IP, chặn **trước** mọi truy vấn DB; token đã xác thực thành công trong 10 phút (khoá Valkey `ob:bearer_ok:<sha256>`) đi qua giới hạn này (T720 M1, C§26.1).
- Rate limit: 60 req/s/token và 20 req/s/base/token (Airtable giới hạn 5 req/s/base — self-host nên nới hơn, cấu hình được), 20 req/s/IP cho endpoint public. Vượt → 429 + `Retry-After`. Áp cho **mọi** route có đăng nhập (trừ health, metrics, URL storage ký); `POST …/records/query` được miễn giới hạn theo base (grid cuộn nhanh + prefetch) nhưng vẫn tính giới hạn theo user.

Endpoint chính (agent bổ sung theo module, không đổi pattern):

```text
POST   /api/v1/auth/login | /logout
GET    /api/v1/auth/providers, /auth/oidc/:provider/start, /auth/oidc/:provider/callback   # C§27 (T707), công khai
POST   /api/v1/auth/forgot-password | /auth/password-reset/:token
POST   /api/v1/orgs/:id/members/:userId/password-reset
POST   /api/v1/bases/:id/export, /workspaces/:id/bases/import      # ADR-24
GET    /api/v1/me
GET|POST /api/v1/setup                           # §14.1A, chỉ khi chưa có user nào
GET    /api/v1/orgs | POST /api/v1/orgs            # POST chỉ khi ALLOW_ORG_CREATION=true
GET|PATCH /api/v1/orgs/:orgId
GET|PATCH|DELETE /api/v1/orgs/:orgId/members[/:userId]   # đổi vai trò org, gỡ thành viên
CRUD   /api/v1/orgs/:orgId/groups, /groups/:id/members
CRUD   /api/v1/orgs/:orgId/workspaces
CRUD   /api/v1/workspaces/:id/members
CRUD   /api/v1/bases/:id/roles, PUT|DELETE /api/v1/bases/:id/role-assignments   # T109
CRUD   /api/v1/workspaces/:id/bases              # ?include_deleted=true: thêm base trong thùng rác người gọi khôi phục được
POST   /api/v1/bases/:id/restore                 # khôi phục base khỏi thùng rác (C§5A)
CRUD   /api/v1/bases/:id/tables
CRUD   /api/v1/tables/:id/fields                 # tạo + liệt kê; sửa/xoá qua /fields/:id
GET|PATCH|PUT|DELETE /api/v1/fields/:id           # PATCH = đổi tên/style/options; PUT = đổi kiểu (C§4.4)
POST   /api/v1/tables/:id/records/query          # body = Query request §7.1
GET    /api/v1/tables/:id/records                # query-string đơn giản
POST   /api/v1/tables/:id/records                # 1 hoặc mảng
PATCH  /api/v1/tables/:id/records                # bulk
GET|PATCH|DELETE /api/v1/tables/:id/records/:recordId
DELETE /api/v1/tables/:id/records                # bulk xoá mềm, body { ids }
GET    /api/v1/tables/:id/records/:recordId/children   # sub-record (T405)
GET    /api/v1/tables/:id/records/:recordId/ancestors  # đường dẫn cha (T405)
POST   /api/v1/tables/:id/records/tree                 # cây theo tầng (T405)
POST   /api/v1/tables/:id/records/group-counts   # đếm theo nhóm (T302, C§1.4)
POST   /api/v1/bases/:id/imports/uploads | GET …/uploads/:uploadId/preview | POST /bases/:id/imports | POST /bases/:id/imports/:jobId/cancel   # CSV/XLSX (T308, C§19)
GET    /api/v1/tables/:id/export?view_id=&format=csv|xlsx
GET|POST /api/v1/tables/:id/views, GET|PATCH|DELETE /views/:id, POST /views/:id/duplicate   # C§15
POST   /api/v1/views/:id/submit | GET /views/:id/submission-status   # form nội bộ (C§17)
GET|POST /api/v1/bases/:id/dashboards, GET /bases/:id/dashboards/trash, GET|PATCH|DELETE /dashboards/:id, POST /dashboards/:id/duplicate | /restore, PUT /dashboards/:id/layout   # C§28.1 (T805)
POST   /api/v1/dashboards/:id/widgets, PATCH|DELETE /widgets/:id, POST /widgets/:id/duplicate   # C§28.2 (T805)
POST   /api/v1/widgets/:id/data   # C§28.3 (T806)
CRUD   /api/v1/bases/:id/automations
POST   /api/v1/automations/:id/test | /enable | /disable | /take-over | /duplicate   # take-over: ADR-25; duplicate: C§21 (T551)
GET    /api/v1/automations/:id/runs, /automation-runs/:id
POST   /api/v1/automation-runs/:id/retry
POST   /api/v1/files/uploads (presign) | /files/uploads/:id/complete
GET    /api/v1/files/:attachmentId               # check quyền → 302 presigned URL (60s)
POST   /api/v1/hooks/:token                      # incoming webhook
GET|POST /api/v1/views/:viewId/share-links (+ /preview), GET|PATCH|DELETE /share-links/:id, POST /share-links/:id/regenerate, GET /bases/:id/share-links, GET /orgs/:id/share-links (+ /revoke)   # C§16
GET|POST /api/v1/shares/:token/...                # truy cập qua link (§15A.3)
GET    /api/v1/jobs/:id                          # trạng thái job nền (meta.jobs)
GET    /api/v1/tables/:id/records/:recordId/history   # §14.4, C§11
POST   /api/v1/tables/:id/records/:recordId/revert
GET    /api/v1/tables/:id/records/trash
POST   /api/v1/tables/:id/records/restore
POST   /api/v1/fields/:id/convert-preview | /restore | /revert-conversion
GET    /api/v1/bases/:id/audit-logs (+ POST /export), /orgs/:id/audit-logs (+ POST /export, POST /redact — chỉ route org)   # C§11.4
GET    /api/v1/bases/:id/members/:userId/access, GET /api/v1/bases/:id/principals   # C§5A, C§14 (T711), chỉ session
GET    /api/v1/me/identities, POST /api/v1/me/identities/:provider/start, DELETE /api/v1/me/identities/:userIdentityId   # C§27.3 (T708), chỉ session
CRUD   /api/v1/orgs/:id/invitations, POST /api/v1/invitations/:token/accept
GET|POST /api/v1/orgs/:orgId/me/api-tokens, PATCH|DELETE /api/v1/api-tokens/:id, GET /api/v1/orgs/:orgId/api-tokens   # C§26.4 (T703), chỉ session
```

Không bao giờ đổi âm thầm contract; thay đổi phá vỡ → `/api/v2` hoặc field mới.

### 13.2 Incoming webhook

S5c: ADR-35 §1–§2 (thắng mục này khi khác — URL lưu hash + bản mã hoá, `auth` chọn tường minh, body ghi vào `meta.incoming_webhook_requests` trong cùng transaction với event rồi `202`, chống replay theo dòng request giữ 7 ngày thay vì 24 h, Valkey không sẵn sàng → `503`, chỉ base admin quản lý). API quản lý (tạo, sửa, xoá mềm, xoay secret, tạo lại token, bật/tắt Bearer, log request): C§25.1 (T602). Route nhận (thứ tự kiểm, mã lỗi, dữ liệu lưu, metric) và nghe mẫu: C§25.2–§25.3 (T603) — thắng các gạch đầu dòng dưới khi khác (chống replay 7 ngày theo dòng request, burst 4× = 20 với mặc định 5 req/s).
- `POST /api/v1/hooks/:token` (token 32 byte random, lưu hash).
- Nếu webhook có secret: xác thực theo **Standard Webhooks** (ADR-22, CONTRACTS §10): header `webhook-id`, `webhook-timestamp` (lệch ≤ 5 phút), `webhook-signature` = `v1,` + base64(HMAC-SHA256(secret, id + "." + timestamp + "." + body)). Chống replay: lưu `webhook-id` 24h, trùng → trả 202 nhưng không xử lý lại.
- Tuỳ chọn **Bearer token** (giống Lark): bật thì request phải có `Authorization: Bearer <token>` (token 32 byte, hiển thị một lần, lưu `bearer_hash`, đặt lại được). Dùng được cùng hoặc thay cho Standard Webhooks. Sai hoặc thiếu → `401 UNAUTHENTICATED`. Token hook sai → `404`. Hook tắt → `404`.
- **Rate limit theo từng hook**: `rate_limit_per_sec` (mặc định 5 req/s, burst 20, admin base chỉnh được tới `WEBHOOK_MAX_RATE_PER_SEC`, mặc định 50) cộng trần 50 req/s mỗi base, đếm trong Valkey. Vượt → `429 RATE_LIMITED` + `Retry-After`. Giới hạn 20 req/s/IP của endpoint public (§13.1) vẫn áp.
- Header `X-Cellhive-Causation` hợp lệ (ADR-27) → event nối tiếp `causation` của automation đã gọi.
- Body ≤ 1 MB. Trả 202 ngay, xử lý qua event `webhook.received`. Action tham chiếu `body`/`headers`/`query` bằng `{ "trigger": … }` (§11.4).

### 13.3 Outgoing (http_request, run_n8n_workflow)

S5c: gửi qua **outbox hai pha** (`meta.http_deliveries` + job `http.deliver`, run chờ ở `waiting`, thử lại 6 lần, `Retry-After` ≤ 1 h tạm dừng cả host, nhịp theo (org, host)) — ADR-35 §4–§5.
Header theo Standard Webhooks (ADR-22, CONTRACTS §10): `webhook-id` (= id dòng giao `hdl_…`, giữ nguyên qua các lần retry, khác nhau giữa các bước — T605, "Câu hỏi mở S5c" #4), `webhook-timestamp`, `webhook-signature` (khi có secret), cộng `Idempotency-Key` và `X-Cellhive-Causation` (ADR-27; token gắn chính instance — host `PUBLIC_URL` + `/api/v1/hooks` — nên bên nhận ngoài bỏ qua, còn n8n chuyển tiếp nguyên header khi gọi ngược `/hooks/:token` thì loop guard nối chuỗi; T616, Sửa đổi ADR-27 §5 / ADR-35 §5, định dạng C§10). Người nhận verify được bằng thư viện `standardwebhooks` có sẵn cho nhiều ngôn ngữ.

Payload chuẩn cho n8n (`run_n8n_workflow`, T607 — định dạng đầy đủ, `null` của `event.id`/`event.entity_id`/`table`/`record`/`changes`, dạng giá trị của `changes`: C§21 "run_n8n_workflow", OpenAPI `N8nWorkflowPayload`; giao theo ADR-35 §4):
```json
{
  "event": { "id": "", "type": "", "entity_id": "", "created_at": "" },
  "automation": { "id": "", "name": "", "run_id": "" },
  "base": { "id": "", "name": "" },
  "table": { "id": "", "name": "" },
  "record": { "id": "", "fields": { "<tên field>": "<giá trị đã format>" }, "fields_by_id": {} },
  "changes": { "<tên field>": { "from": null, "to": null } }
}
```
Không đưa secret, token, field mà `run_as` không có quyền đọc (ADR-25) vào payload: payload dựng lúc chạy bằng quyền `run_as` lúc đó (không phải lúc lưu), `fields` theo tên dạng `cell_format=text`, `fields_by_id` theo id dạng `cell_format=json`.

---

## 14. Phân quyền & bảo mật

### 14.1 Mô hình quyền (theo "Advanced permissions" của Lark Base — ở đây miễn phí và luôn bật)

**Cấp org**: `owner`, `admin` (toàn quyền mọi base), `member`.

**Quy tắc quản trị (chốt khi làm T008)**:
- Workspace: org owner/admin tạo và xoá; workspace admin đổi tên và quản lý thành viên workspace. Không xoá được workspace còn base (kể cả base trong thùng rác) → `422 VALIDATION_FAILED` / `WORKSPACE_NOT_EMPTY`. User thấy workspace khi là thành viên (trực tiếp hoặc qua group) hoặc có quyền vào ít nhất một base trong đó.
- Base: workspace admin hoặc org owner/admin tạo; `admin` sửa cài đặt; owner, workspace admin, org owner/admin xoá (role `admin` của base thì không); owner hiện tại hoặc org owner/admin chuyển chủ.
- Thành viên org: mọi thành viên xem được danh sách (gồm email); chỉ owner đổi/gỡ owner hoặc nâng người khác lên owner; thành viên tự rời được; không hạ/gỡ được owner cuối cùng (`LAST_OWNER`). Đổi role org hoặc gỡ thành viên → tăng `permission_version` mọi base của org.
- Group: mọi thành viên org xem được; tên duy nhất trong org, không phân biệt hoa thường (`409 NAME_CONFLICT`).
- Lời mời: admin mời được admin; mời người đã là thành viên → `ALREADY_MEMBER`; chấp nhận không tự đăng nhập; link `<PUBLIC_URL>/invite/<token>`, dùng ngôn ngữ mặc định của org cho email.
- Tra cứu vượt tenant được phép (ngoại lệ có kiểm soát của quy tắc vàng #5): **chỉ** trong `packages/server-core/src/db/cross-tenant-lookups.ts`, có test khoá danh sách export và test cấm GlobalRepository chạm bảng tenant. Danh sách chốt: `listMembershipsOfUser` (membership của chính người gọi; với user khác chỉ dùng cho fan-out audit auth và kiểm tra đích khi admin đặt lại mật khẩu, không trả cho người khác), `lockUserMemberships` (kiểm lại link đặt lại mật khẩu do admin tạo), `findInvitationOrganization` (chỉ trả org id), `findShareLinkOrganization` (T304: từ hash token share link, chỉ trả org id), `findApiTokenByHash` (T703/T704: request `Authorization: Bearer cht_…` từ SHA-256 của token có ≥ 178 bit ngẫu nhiên, chỉ trả org id + token id — kể cả token đã thu hồi/hết hạn, để xác thực phân biệt sau khi đọc token trong scope org), `purgeExpiredOperationalRows` (idempotency key, job, bộ đếm batch automation, dòng `meta.incoming_webhook_requests` quá 7 ngày — T602, dòng giao HTTP `test` quá 24 giờ — T605, API token đã thu hồi/hết hạn quá 90 ngày — T703), `createMonthlyPartition` / `dropMonthlyPartitionsBefore`, `listExpiredExportFiles` (file export và báo cáo lỗi import hết hạn), `listExpiredImportUploads` (T308: file upload import hết hạn, chỉ trả org id + id), `listExpiredAttachments` (T406: attachment chưa gắn quá 24h, đã gỡ quá 30 ngày, của record đã xoá vĩnh viễn (T408) hoặc thuộc field đã purge, cho cron `attachments.cleanup`, chỉ trả org id + id), `listExpiredFormCovers` (T419: ảnh bìa form upload quá 24h mà không view form nào của org trỏ tới, cho cron `attachments.cleanup`, chỉ trả org id + id), `listExpiredEmailAssets` (T534: ảnh email upload quá 24h mà không chữ ký mặc định của org, chữ ký danh tính hay định nghĩa automation sở hữu nào của chính org đó tham chiếu `asset:<id>`, cho cron `attachments.cleanup`, chỉ trả org id + id), `listOrganizationsWithTables` (T408: org có ít nhất một table, cho cron `records.purge` tạo job theo org, chỉ trả org id), `listExpiredFieldConversions` (T403: đổi kiểu field quá 7 ngày cho cron `field.conversion_cleanup`, chỉ trả org id + job id), `listExpiredTrashedTables` (T461: table trong thùng rác quá 30 ngày chưa purge, cho cron `tables.purge` tạo job theo org, chỉ trả org id + table id), `purgeExpiredNotifications` (T511: xoá thông báo quá `NOTIFICATION_RETENTION_DAYS` theo tuổi, cho cron `notifications.cleanup`, chỉ trả số dòng), `listPendingEmailRecipients` (T512: người nhận còn email thông báo `pending`, cho cron `notifications.daily_digest` xét giờ tóm tắt theo timezone từng người, chỉ trả org id + user id), `listOrganizationsWithExpiredAutomationRuns` (T518: org có run automation đã kết thúc quá `AUTOMATION_RUN_RETENTION_DAYS`, cho cron `automation.runs_cleanup` xoá theo lô trong từng org, chỉ trả org id), `listTimeTriggerAutomations` (T508: automation đang bật có trigger `schedule`/`record.date_reached` ở mọi org, cho cron `automation.schedule_tick`/`automation.date_scan`, chỉ trả org id + automation id), `listStaleNotificationBuffers` (T542: nhóm của `meta.notification_buffer` có hàng cũ hơn 10 phút — job `notifications.flush` đã mất — cho cron `notifications.cleanup` lên lịch xả lại, chỉ trả org id + `kind` + `group_key`), `listOrganizationsWithPendingTelegramLinks` (T549: bot `(organization_id, secret_id)` còn link Telegram chờ — chưa dùng, chưa hết hạn — cho cron `notifications.telegram_poll` mỗi phút, chỉ trả org id + secret id; job kiểm lại trong scope org rằng secret còn là bot thông báo), `findIncomingWebhookByTokenHash` (T602: route công khai `POST /hooks/:token` từ SHA-256 của token URL 32 byte, chỉ trả org id + hook id — kể cả hook đã xoá/tắt để mọi trường hợp trả cùng `404` sau khi đọc trong scope org), `listDateReminderFields` (T547: field `datetime` có nhắc hạn — dòng `meta.date_reminder_cursors` — ở mọi org, cho cron `notifications.date_reminder_scan` mỗi phút, chỉ trả org id + field id; mỗi field được khoá, đọc và quét trong scope org), `measureHttpDeliveryBacklog` (T605: số dòng giao HTTP `pending`/`sending` và tuổi dòng cũ nhất ở mọi org, cho gauge `http_delivery_oldest_pending_seconds` của `/metrics`, chỉ trả hai con số), `listStuckHttpDeliveries` (T702: dòng giao HTTP `pending` quá `next_attempt_at` 60 s hoặc `sending` quá `lease_until` 30 s ở mọi org — job `http.deliver` đã mất — cho cron `http.deliveries_rescue` mỗi phút, ≤ 500 dòng, chỉ trả org id + id; mỗi dòng được đọc lại và thêm lại job trong scope org), `findTelegramWebhookByPathHash` (T609: route công khai `POST /telegram/webhook/:pathToken` từ SHA-256 của path token 24 byte, chỉ trả org id), `listTelegramBotsForSparsePoll` (T609: bot thông báo ở chế độ `polling` có kênh `linked` qua chính bot đó, cho cron poll thưa 15 phút, chỉ trả org id + secret id; job kiểm lại trong scope org), `listTelegramWebhooksToCheck` (T609: org có dòng `meta.telegram_webhooks`, cho cron `notifications.telegram_webhook_check` mỗi giờ, chỉ trả org id).

**Khởi tạo instance và tạo org (§14.1A)**:
- Instance mới chưa có user nào → `GET /api/v1/setup` trả `{ "setup_required": true }`; `POST /api/v1/setup` với `{ email, password, display_name, org_name, locale, timezone }` tạo trong **một transaction**: user, org, membership `owner`. Đã có user → `409 SETUP_COMPLETED`. Tương đương CLI: `cellhive setup --email … --org …` (in link đặt mật khẩu thay vì nhận mật khẩu qua tham số dòng lệnh).
- Endpoint setup chỉ trả lời khi chưa có user; có rate limit; audit `setup.completed` (`organization_id` = org mới).
- Tạo thêm org: mặc định chỉ qua CLI `cellhive org create --name … --owner-email …`. Bật `ALLOW_ORG_CREATION=true` thì user đã đăng nhập tạo được org qua `POST /api/v1/orgs` (trở thành owner).
- Người mới vào org chỉ qua lời mời (`meta.invitations`); link mời trả về trong response cho người mời (không log), gửi email nếu có SMTP.
**Cấp workspace**: `admin` (tạo/xoá base, quản lý thành viên workspace), `member` (thấy các base mình được gán role).

**Cấp base — role**. Mỗi base có:
- `owner` (người tạo base, chuyển giao được) — toàn quyền, không chỉnh được.
- 3 role hệ thống: `admin` (quản lý schema, view, automation, dashboard, role, chia sẻ; toàn quyền dữ liệu), `editor`, `reader`. Editor/reader chỉnh cấu hình được nhưng bị **giới hạn trần**: reader không bao giờ có quyền sửa/thêm/xoá.
- Role tuỳ chỉnh (`custom`): không giới hạn số lượng.
- Mỗi principal (user hoặc group) được gán **đúng một** role trong một base.

**Cấu hình role** (`meta.base_roles.config`, zod schema trong `packages/permissions`, cấu trúc tương đương `AdvPermBaseRoleConfig` của Lark nhưng khoá bằng ID thay vì tên):

```json
{
  "base_rule": { "copy": false, "download": false, "share_link": false },
  "tables": {
    "tbl_orders": {
      "perm": "edit",
      "view_rule": { "allow_edit": true, "visible_views": null },
      "record_rule": {
        "operations": ["add", "delete"],
        "edit_filter": { "op": "and", "items": [{ "field": "fld_owner", "operator": "has_any_of", "value": [{ "$var": "current_user" }] }] },
        "read_scope": "all",
        "read_filter": null
      },
      "field_rule": {
        "mode": "specify",
        "fields": { "fld_amount": "read", "fld_cost": "no_perm" },
        "option_edit_fields": [],
        "file_download_fields": []
      }
    },
    "tbl_internal": { "perm": "no_perm" }
  },
  "dashboards": { "dsh_sales": "read_only" }
}
```

Ngữ nghĩa (bắt buộc cài đúng, test theo `CONTRACTS.md` §5):
- `tables.<id>.perm`: `manage` (như edit + sửa schema/view/automation của table đó), `edit`, `read_only`, `no_perm`. Table không có trong config của role custom = `no_perm` (**mặc định từ chối**).
- `view_rule.allow_edit`: được tạo/sửa/xoá view chung. `visible_views`: `null` = tất cả; mảng = chỉ những view đó (ẩn view khác trong UI **và** API không cho truy vấn qua view bị ẩn).
- `record_rule.operations`: `add`, `delete` (chỉ có nghĩa khi `perm = edit|manage`; `read_only` → luôn rỗng).
- `record_rule.edit_filter`: record được sửa (và xoá nếu có `delete`) phải khớp filter; `null` = mọi record.
- `record_rule.read_scope`: `all` (đọc mọi record) | `editable` (chỉ đọc record khớp `edit_filter`) | `filter` (đọc theo `read_filter` riêng). Giống Lark: mặc định phạm vi đọc = phạm vi sửa khi role giới hạn record.
- Filter hỗ trợ biến `current_user` (field user/created_by chứa user hiện tại) và `current_user_groups`.
- Field `link` dùng được trong `edit_filter`/`read_filter` (T710) với toán tử link của §6.2 theo **id** record đích còn sống (record đích vào thùng rác không còn tính, khôi phục → tính lại), không `$var`. Đánh giá bằng planner SQL (subquery junction như filter view); edit rule nêu field link được kiểm **sau** khi ghi trên dòng đã ghi gồm ô link (ra ngoài rule → `403 RECORD_RULE_VIOLATION`, rollback). Field link trong rule bị xoá/đổi kiểu → rule không validate → fail closed.
- `field_rule.mode`: `all_edit`, `all_read`, `specify`, `no_perm`. Quyền từng field: `edit` (thêm + sửa + đọc), `create` (chỉ ghi khi tạo record mới + đọc), `read`, `no_perm`.
- Field `formula`, `lookup`, `auto_number`, `created_*`, `updated_*` luôn bị hạ tối đa thành `read` (tự động).
- Field dùng trong `edit_filter`/`read_filter` tối thiểu phải là `read`; nếu role có `add` thì các field đó tối thiểu `create` (để record mới tạo ra còn khớp rule). Hệ thống tự áp khi lưu role, UI hiển thị lý do.
- `option_edit_fields`: field `select` mà role được thêm/sửa option (khi nhập giá trị mới hoặc dùng `typecast`). Mặc định không ai ngoài admin được thêm option.
- `file_download_fields`: nếu `mode = specify`, chỉ tải được file ở các field này (xem vẫn được nếu có `read`).
- `base_rule.copy`: được copy nội dung ra clipboard (grid chặn copy khi false); `download`: được export CSV/XLSX, in, nhân bản base; `share_link`: được tạo share link (§15A). Mặc định `false` với role custom.
- `dashboards.<id>`: `read_only` | `no_perm`; dashboard không liệt kê = `no_perm`. Widget vẫn áp record/field rule của role lên dữ liệu.

**Thứ tự giải quyết** (`packages/permissions`, hàm thuần, test đầy đủ):
1. Org owner/admin, base owner, workspace `admin` của workspace chứa base, role `admin` → toàn quyền base.
2. Principal có role gán **trực tiếp cho user** → dùng role đó.
3. Nếu không, user thuộc các group có role → **hợp** quyền: perm cao nhất; operations hợp; filter nối bằng OR; field perm cao nhất; base_rule OR.
4. Không có role → không truy cập base. Chỉ là `member` của workspace **không** cho quyền vào base nào; nó chỉ cho thấy workspace trong điều hướng và danh sách các base mà user có role. Role base gán trực tiếp vẫn có hiệu lực dù user không phải member workspace (user phải là member org).
5. Automation chạy với quyền của **`run_as`** = người bật hoặc sửa `definition` gần nhất (ADR-25, §11.1), không phải `created_by`. Sửa automation → `run_as` chuyển sang người sửa (UI cảnh báo trước khi lưu). `run_as` mất quyền → automation tắt ngay, báo owner + admin base, người quản lý khác "nhận quản lý" (take over) để bật lại.
6. API token: giao của quyền **hiện tại** của user sở hữu (resolve mỗi request như session), scopes của token (bảng route → scope C§26.3, `ScopeGuard`), `base_ids` của token và org của token (`AccessService`: org khác, base ngoài `base_ids` → `404` như không tồn tại) — T704, ADR-36 §1.
7. Share link: giao của quyền người tạo link và phạm vi link (§15A).

Chi tiết cài đặt (chốt khi làm T009):
- Field không liệt kê trong `field_rule.fields` lấy mặc định theo `mode` (`all_edit`/`specify` → `edit`, `all_read` → `read`, `no_perm` → `no_perm`); table `read_only` giới hạn field tối đa `read`; `create` khi role không có `add` → `read`.
- Role hệ thống: editor = mọi table `edit`, `add`+`delete`, sửa được view, `copy`/`download`/`share_link` = true, mọi dashboard `read_only`, không sửa schema; reader = mọi table `read_only`, `copy`/`download` = true, `share_link` = false. Hai role này tự áp cho table/dashboard tạo sau; role custom mặc định từ chối.
- "Role `admin`" ở bước 1 là role có hiệu lực sau bước 2–3: role trực tiếp `reader` thắng group `admin`.
- Hợp nhiều group: `read_scope` = `all` nếu có role không hạn chế đọc, giữ nguyên nếu mọi role cùng scope, còn lại `filter`; `edit_filter` chỉ lấy từ role có `edit`/`manage`. Record phải khớp phạm vi đọc **và** phạm vi sửa mới sửa được.
- Không phải member org → không có quyền, kể cả khi có role base trực tiếp. `access.role` = `null` khi toàn quyền đến từ org/base owner/workspace admin hoặc khi hợp nhiều group.
- Normalize được áp lại lúc resolve, nên đổi schema sau khi lưu role không nới rộng quyền.
- Đổi thành viên group (thêm/gỡ thành viên, xoá group) tăng `permission_version` của: base mà group có role, mọi base của workspace group làm admin, và mọi base của org có role mà config dùng `current_user_groups` (bất kể role gán trực tiếp hay qua group, vì biến này phụ thuộc thành viên của mọi group của người dùng).

`permission_version` của base tăng khi đổi role, gán role, hay đổi schema ảnh hưởng filter → dùng cho cache và cho server đẩy lại quyền qua WS.

Frontend ẩn field **không phải** bảo mật; mọi kiểm tra ở server. Các mục khác trong spec nói "record rules" = `record_rule`, "field permissions" = `field_rule` của role hiệu lực.

### 14.2 Bảo mật bắt buộc
- Cookie session: `HttpOnly; SameSite=Lax` + `Secure` theo `COOKIE_SECURE` (dòng dưới), rotate khi login; CSRF **signed** double-submit token (HMAC gắn với session id, theo OWASP) cho request có cookie.
- `Secure` điều khiển bằng env `COOKIE_SECURE=auto|true|false` (mặc định `auto`: bật khi request đến qua HTTPS, xác định bằng `X-Forwarded-Proto` từ proxy tin cậy `TRUSTED_PROXIES`). Nhiều người tự host trong LAN qua `http://`; nếu `Secure` cứng thì đăng nhập thất bại không báo lỗi. Khi chạy HTTP, UI admin hiển thị cảnh báo; tài liệu self-host hướng dẫn bật HTTPS.
- CORS: chỉ origin cấu hình.
- Mật khẩu argon2id (m=19456 KiB, t=2, p=1), 10–256 ký tự, không nằm trong danh sách mật khẩu phổ biến (lọc từ SecLists `100k-most-used-passwords-NCSC`, ghi nguồn trong `THIRD_PARTY_NOTICES.md`). 10 lần sai liên tiếp trong 15 phút → khoá 15 phút (`423 ACCOUNT_LOCKED`); bộ đếm trong Valkey theo email, tăng **trước** khi verify nên request song song không vượt 10 lần verify. Access log chỉ ghi route template và path đã che token.
- **Đặt lại mật khẩu** (hoạt động cả khi không có SMTP):
  - Org owner/admin đặt lại cho thành viên: `POST /orgs/:id/members/:userId/password-reset`, **chỉ khi** người đó chỉ thuộc duy nhất org này và không phải `owner` (user là bảng toàn cục; nếu không giới hạn thì admin org A chiếm được tài khoản của chủ org B). Trường hợp khác → `403 PERMISSION_DENIED`, dùng CLI. Kết quả → trả **link đặt lại dùng một lần** (token 32 byte, lưu hash, hết hạn 24h) để admin tự gửi cho người dùng; không bao giờ trả hay đặt mật khẩu thay người dùng.
  - Có SMTP: `POST /auth/forgot-password` gửi link qua email; luôn trả `202` dù email có tồn tại hay không (chống dò tài khoản), rate limit 5/giờ/email và 20/giờ/IP. Không có SMTP: endpoint trả `202` nhưng không làm gì, UI ẩn nút "Quên mật khẩu" và hướng dẫn liên hệ admin.
  - Owner, người thuộc nhiều org, hoặc chính admin duy nhất quên mật khẩu: lệnh CLI trong container `cellhive user reset-password --email <email>` in ra link đặt lại (cần quyền truy cập máy chủ, ghi audit với `actor_type = system`, `organization_id = NULL`).
  - Đặt lại thành công: huỷ mọi session và mở khoá tài khoản; audit `auth.password_reset` (không log token). User đăng nhập bằng OIDC không có mật khẩu thì không dùng luồng này.
- **OIDC** (S6, ADR-36 §3): provider cấu hình cấp instance qua env `OIDC_*` (§20); authorization code + PKCE S256 + `state` + `nonce` (state trong cookie mã hoá một lần); định danh `(provider, sub)`; không tự liên kết theo email trừ khi `OIDC_<SLUG>_LINK_BY_EMAIL=true` và `email_verified = true`; JIT tắt mặc định; liên kết/gỡ thủ công trong hồ sơ. Map group → role, bắt buộc SSO, RP-initiated logout: ngoài S6.
  - T707 (C§27.2): cookie `ob_oidc` AES-256-GCM (HKDF `SESSION_SECRET`, `info = oidc-state:v1`), `Path=/api/v1/auth/oidc/`, 10 phút, xoá trước mọi bước của callback; `state` so constant-time; ID token kiểm `iss`, `aud`/`azp`, `exp`, `iat` ±5 phút, `nonce` (`openid-client` v6) và chữ ký JWKS (cache 1 giờ, nạp lại khi `kid` lạ); có user cùng email mà chưa liên kết → `OIDC_ACCOUNT_EXISTS` (không identity, không session); tạo user chỉ khi `ALLOW_SIGNUP` + `email_verified === true` + domain trong `ALLOWED_DOMAINS` (nếu đặt), không mật khẩu, `AUTO_JOIN_ORG` → `member`; session như đăng nhập mật khẩu (rotate); lỗi → `302 /login?error=<CODE>`. Gọi IdP là ngoại lệ có tên của "một cửa mạng ra" (§14.3), timeout 10 s.
  - T708 (C§27.3): liên kết thủ công khi đang đăng nhập (`POST /me/identities/:provider/start` có CSRF → `authorization_url` với `max_age=0`, callback đòi `auth_time` ≤ 10 phút; cookie state chế độ `link` buộc user + session — đổi giữa chừng → `OIDC_STATE_INVALID`), một tài khoản mỗi provider, identity của user khác → `IDENTITY_IN_USE`; gỡ (không gỡ được phương thức đăng nhập cuối — `LAST_LOGIN_METHOD`); liên kết theo email khi đăng nhập chỉ khi `LINK_BY_EMAIL=true` + `email_verified === true`; khoá dòng user cho mọi thay đổi phương thức đăng nhập; CLI `cellhive user reset-password` là break-glass cho user chỉ OIDC.
- Secret (SMTP, bot token, API key LLM, webhook secret) mã hoá AES-256-GCM với `APP_MASTER_KEY` từ env; không bao giờ trả về qua API sau khi lưu.
- `statement_timeout` 10s cho query người dùng; 60s cho job.
- Mọi input qua zod; mọi SQL qua Kysely với parameter; identifier chỉ từ meta.
- Không thực thi JS/Python do người dùng cung cấp ở bất kỳ đâu.
- Upload: whitelist MIME theo cấu hình, tối đa 100 MB/file, tính sha256; quét ClamAV là Phase 2 (để hook `status=pending_scan` sẵn trong `meta.attachments`).
- Audit log cho: login/logout/login fail, đổi schema, CRUD record (before/after chỉ các field thay đổi), đổi quyền, CRUD automation, API token, webhook, dashboard, cài đặt AI, xuất dữ liệu (export). Chi tiết ở §14.4.

### 14.3 SSRF (bắt buộc vì server chạy trong mạng nội bộ)

Theo ADR-35 §3 (T600). Mọi lời gọi HTTP ra tới URL do người dùng cấu hình (`http_request`, `run_n8n_workflow`, sau này tải ảnh từ URL) đi qua **một cửa** `packages/server-core/src/net/**` (test khoá: không module nào của `automation/**`, `http-out/**`, `webhooks/**` tự mở kết nối; `TelegramClient` host cố định là ngoại lệ ghi rõ):
- **URL** (`parseOutboundUrl`): chỉ `http`/`https`, ≤ 2.048 ký tự sau render, không userinfo, không zone id IPv6, không khoảng trắng/ký tự điều khiển; host IDN → punycode, IPv4 mọi cách viết (`0x7f.1`, `2130706433`) chuẩn hoá trước khi kiểm. Cổng 80/443 hoặc cổng nêu trong mục allowlist khớp host (`port_not_allowed`).
- **Resolve một lần** (`resolveOutboundTarget`): lấy **mọi** địa chỉ A + AAAA; **mọi** địa chỉ phải được phép — một địa chỉ bị chặn → từ chối cả host (tên trả [công khai, private] không dùng được để tới địa chỉ private); IP literal và IPv6 chứa IPv4 (mapped, NAT64, 6to4) kiểm như địa chỉ đã resolve. Phân loại `classifyAddress` (`net/address-class.ts`, dùng chung với SMTP):
  - **không bao giờ mở được** (kể cả allowlist; `blocked_address`): `0.0.0.0/8`, `::`, multicast, broadcast/dành riêng `240.0.0.0/4`, metadata cloud (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::254`);
  - **private** (`private_address` trừ khi allowlist mở): loopback, RFC1918, link-local, CGNAT, ULA/link-local/site-local (`fec0::/10`) IPv6, Teredo `2001::/32`, dải tài liệu/benchmark (cả `3fff::/20`); IPv4 nhúng trong IPv6 (mapped, IPv4-translated `::ffff:0:0/96`, NAT64 `64:ff9b::/96` và `64:ff9b:1::/48`, 6to4) xét theo IPv4 (T616);
  - còn lại công khai.
- **Allowlist của org** `meta.http_allowlist` (§5.10, C§25.4): theo **tên host** (chính xác hoặc `*.hậu_tố` ≥ 2 nhãn, `:cổng` tuỳ chọn), không IP/CIDR. Mục khớp mở địa chỉ private cho host đó (mục không cổng: cổng 80/443; có cổng: đúng cổng đó); **loopback** chỉ khi mục nêu **đúng host và cổng** (không wildcard). Env `HTTP_PRIVATE_ALLOWLIST=off` (§20): allowlist không mở địa chỉ private nào, chỉ cho cổng khác trên host công khai (instance nhiều org không tin nhau).
- **Kết nối bằng IP đã kiểm** (`guardedRequest`, `node:http(s)`, không dependency): `lookup` trả đúng địa chỉ đã chọn (chống DNS rebinding), `Host`/SNI/kiểm chứng chỉ theo tên host gốc; `blockList` của socket chặn lại dải "không bao giờ mở được" (lớp thứ hai); agent riêng mỗi lời gọi, **không** dùng `HTTP(S)_PROXY` (proxy egress là P2).
- **Không follow redirect** (`3xx` trả về như response). Timeout kết nối 5 s, tổng 10 s (`http_timeout`); response đọc tối đa 1 MiB — tính cả trên dây lẫn **sau giải nén** gzip/deflate/br — rồi huỷ (`http_response_too_large`); lỗi khác `http_network`. Lỗi không chứa URL, địa chỉ, header, body; log chỉ host.
- **Nhịp theo đích** (`HostPacer`, Valkey, script Lua hằng): token bucket (org, host) 10 lời gọi/giây burst 20, khoá tạm dừng (org, host) từ `Retry-After` (≤ 1 h), ≤ 2 lời gọi đang bay mỗi org (lease 30 s); trả "chờ tới …" thay vì ngủ; Valkey lỗi → "chờ" (`unavailable`). Metric `http_ssrf_blocked_total{reason}` (`private_address` | `blocked_address` | `port_not_allowed` | `invalid_url` | `unresolvable`).
- **Host SMTP của danh tính gửi** (T530, ADR-33 §1A): chỉ cổng 25/465/587/2525; host resolve và kiểm **mọi** địa chỉ khi lưu **và** mỗi lần mở kết nối, socket mở tới chính địa chỉ vừa kiểm (chống DNS rebinding), TLS kiểm chứng chỉ theo tên host. Chặn private/loopback/link-local/CGNAT/ULA trừ khi `SMTP_ALLOW_PRIVATE_HOSTS=true`; luôn chặn địa chỉ không xác định, multicast, dành riêng và metadata cloud (`169.254.169.254`, `fd00:ec2::254`…). Không dùng `meta.http_allowlist`.

### 14.4 Audit & lịch sử record (ADR-23)
- Ghi trong **cùng transaction** với mutation, qua `AuditWriter` (T010). `RecordMutationService` bắt buộc nhận `AuditContext { actor, via, batch_id, request_id, ip, user_agent }`.
- Record: 1 dòng audit / record / mutation; thao tác hàng loạt (dán nhiều ô, fill-down, bulk, upsert, import) chung `batch_id` (`req_…`, `job_…`, hoặc `run_…` với ghi từ automation, ADR-26) để UI hiển thị "A đã sửa 500 ô". Event `record.*` mang cùng `batch` + `via` (ADR-26). Link ghi cả hai phía. Computed field **không** ghi audit.
- Xoá cứng record (T408: xoá vĩnh viễn từ thùng rác hoặc job `records.purge` sau 30 ngày): không có dòng theo record, một dòng tóm tắt `record.purged` (`entity_type = table`, `after = { count, record_ids }`) mỗi request (≤ 1.000 id) hoặc mỗi lô ≤ 500 record của job (ADR-23 §2, C§8).
- Giá trị lưu dạng lưu trữ; API render theo meta hiện tại.
- **Nguồn API token** (ADR-36 §1, T705): ghi qua token có `actor` = user sở hữu (`updated_by`, lọc theo người, thông báo như user), `via.api_token_id` ghép với `via` có sẵn (revert, import); lịch sử/audit/export audit chỉ nêu id + tên **hiện tại** của token cho org owner/admin và chủ token, người khác thấy "API token" không id/tên (C§11.1).
- Xem lịch sử: cần quyền đọc record **hiện tại**; chỉ trả field người xem **hiện** có quyền đọc; entry chỉ gồm field bị ẩn thì bị loại hẳn.
- Thùng rác hiển thị `deleted_at`, `deleted_by`; khôi phục qua `POST /records/restore`.
- Khôi phục giá trị cũ = mutation mới (`via.reverted_from`), không sửa lịch sử.
- `AUDIT_RETENTION_DAYS` (mặc định 365, `0` = vĩnh viễn), xoá theo partition. Bảng append-only bằng trigger; xoá dữ liệu cá nhân qua hàm redact (chỉ org **owner**, có audit).
- Không audit thao tác đọc, trừ export, tải file qua share link, AI, xem audit log.
- Từ S10, tab Lịch sử của record hiển thị thêm các mục phê duyệt (`approval.*`, ADR-29) chung timeline, cùng quy tắc quyền đọc. Bình luận (S11) nằm ở tab riêng; audit `comment.*` chỉ ghi id, không ghi nội dung.

---

## 15. Realtime

- WebSocket `/ws` trên chính HTTP server của Fastify (lib `ws`, `noServer`, gắn vào sự kiện `upgrade`; không dùng NestJS WS adapter: cần trả HTTP 401/403/429 trước khi nhận kết nối, và project không phát decorator metadata). Xác thực bằng session cookie lúc bắt tay + kiểm `Origin` (thay CSRF); client không phải trình duyệt dùng API token qua header `Authorization: Bearer` lúc bắt tay (S6, ADR-36 §2 — thay "token ở message đầu"; nhánh này không kiểm `Origin`, cần scope `records:read`, không kênh `user:`). Chi tiết bắt tay, giới hạn, heartbeat, mã đóng: CONTRACTS §7.
- Kênh: `base:{id}`, `table:{id}`, `dashboard:{id}` (S7, T807: gợi ý `dashboard.changed`/`dashboard.data_changed` không mang giá trị, gom 5 s mỗi dashboard từ bản đồ table → dashboard trong bộ nhớ — CONTRACTS §7, §28.5), `user:{id}` (`job.progress`; từ S5 `notification.created` — T511, C§7/§22; từ S5b `channel.changed` — T549, C§7/§22.7; từ S10 `approval.changed`, ADR-29). Server kiểm tra quyền khi subscribe (`AccessService`; không đọc được → `NOT_FOUND`).
- Fan-out giữa nhiều instance api qua Valkey pub/sub (T209): mỗi org một channel `rt:org:<org_id>`; api và worker publish **envelope** (`packages/server-core/src/realtime`, zod, có `v`) chỉ mang id + dữ liệu dạng lưu trữ, không mang giá trị đã lọc theo người. Mỗi instance api chỉ subscribe channel của các org đang có subscription cục bộ (đếm tham chiếu), xử lý envelope của một org **tuần tự** theo thứ tự publish, rồi chuyển cho `DeliveryStrategy` theo `type` (tính message cho từng subscriber từ quyền đã lưu của subscription, không đọc DB cho từng người; T210 thêm strategy cho record). Envelope `type` lạ bị bỏ qua (rolling deploy).
- Publish sau commit: `db.withTx` có `afterCommit(tx, hook)` (hook chạy theo thứ tự sau commit, rollback thì bỏ). Bus được gắn vào `Db` của mỗi process (`attachRealtimePublisher`), nên `BasesRepository` (mọi lần `permission_version` tăng, base vào/ra thùng rác, đổi chủ → envelope `permission.changed` với danh sách base) và `JobsRepository` (mọi lần đổi trạng thái/tiến độ → `job.progress` tới `user:` người tạo) tự phát ở cả api lẫn worker; `SchemaService` phát `schema.changed` qua `SchemaChangePublisher`. Khi nhận `permission.changed`, mỗi instance kiểm lại subscription của các base đó (C§7).
- **Record (T210)**: trong transaction ghi, `RecordMutationService` (create/update/upsert/delete/restore/revert và job `removeSelectOptionValues`, `recomputeAutoNumber`) giữ cho mỗi record đã đổi **ảnh trước/sau** dạng lưu trữ của field đã đổi + mọi field có trong `edit_filter`/`read_filter` của bất kỳ role nào của base — kể cả ô link (id record đích còn sống) của field link mà rule nêu (T710) — (`RecordRuleFields`, cache theo base + `permission_version`, mỗi transaction chỉ thêm một lần đọc `meta.bases` theo khoá chính), và giá trị `cell_format=json` sẽ hiển thị (tạo: mọi field; sửa: field đã đổi + `updated_at`/`updated_by`; một lần tra member cho ô user). Sau commit (`afterCommit`; rollback thì không phát; `schema.changed` của option tạo từ typecast phát trước) → envelope `record.changes` (một table/transaction, tách khi > 500 thay đổi hoặc ≈ 512 KiB; kèm type + options thô của các field trong ảnh). Không có bus (CLI, seed) thì không chụp ảnh. Ở api, `RecordDeliveryStrategy` gom subscriber `table:` theo fingerprint quyền (field thấy được + read rule; thêm user, múi giờ, thành viên group khi rule có `$var`/`$date`), mỗi nhóm validate rule trên meta của envelope rồi `evaluate` (`@cellhive/filter-dsl`) trên ảnh trước/sau — không đọc DB theo người; rule không validate được (field đã mất) → không đọc được gì (fail closed). Kết quả theo bảng C§7. Biến của rule (múi giờ người dùng; thành viên group chỉ khi rule dùng `current_user_groups`) lấy lúc subscribe và mỗi lần kiểm lại quyền. Việc lọc và gửi được chia lát ~10 ms (`setImmediate`); cùng một message dùng chung cho cả nhóm nên chỉ serialize một lần. Đo (unit bench `record-delivery.test.ts`, 200 subscriber / 5 role / sửa 1 000 record): parse ≈ 3 ms + lọc ≈ 12–14 ms (140 300 message, 1 800 object khác nhau), event loop bị chặn tối đa ≈ 15 ms (ngưỡng test 50 ms); độ trễ sửa qua HTTP ở instance A → WS ở instance B: p95 ≈ 13 ms trên 50 lần (integration test, ngưỡng 1 s).
- **Theo view (T313, ADR-0031)**: subscription `table:` có thể mang view đang mở (`view: { id, filter_mode }`, C§7). `RecordRuleFields` thêm vào ảnh các field được nêu trong filter đã lưu của mọi view của table (đọc `meta.views` mỗi transaction ghi). Strategy gom subscriber theo (fingerprint quyền, filter view áp dụng — cả filter khi `and`, phần ẩn với subscriber khi `replace`) và đánh giá read rule AND filter view trên ảnh, nên pill/`added`/`removed_from_view` theo view, kể cả điều kiện trên field subscriber không đọc được, mà không lộ giá trị. `schema.changed` entity `view` và `permission.changed` → router nạp lại view của các subscription liên quan trước envelope kế tiếp của org.
- **Message gom (T303)**: một lần ghi (transaction) làm một nhóm subscriber nhận > 100 message theo từng record (`REALTIME_RECORD_BATCH_THRESHOLD`) → nhóm đó nhận **một** `record.batch` (C§7: `channel`, `actor_id`, `count`, `ops`; không id, không giá trị) thay cho N message; ≤ 100 → message từng record như T210. Quyết định ở `RecordDeliveryStrategy` sau cùng bước lọc T210 (field thấy được + `evaluate` read rule trên ảnh trước/sau), nên số đếm chỉ gồm record nhóm đó đọc được; trên ngưỡng không dựng patch nữa (chỉ đếm). Publisher gắn `batch: { id, part, parts }` cho các envelope `record.changes` của cùng một lần ghi bị tách (> 500 thay đổi/≈ 512 KiB); strategy giữ số đếm/message của từng nhóm tới envelope cuối (envelope một tổ chức xử lý tuần tự, theo thứ tự publish) rồi mới phát cho subscriber còn đăng ký lúc đó; phần chờ quá 30 s (mất envelope) hoặc quá 64 lần ghi đang chờ bị bỏ. Instance cũ bỏ qua `batch` (zod strip) và xử lý từng envelope như trước (rolling deploy). Worker (job xoá option, `auto_number`, import T308) phát qua cùng publisher, mỗi lô một transaction → mỗi lô tối đa một `record.batch`/nhóm. Mỗi router có instance strategy riêng (`defaultDeliveryStrategies()`). Đo (unit bench `record-delivery.test.ts`, 200 subscriber / 5 role): 1 000 record → 160 `record.batch` + 300 message từng record (Sales), event loop bị chặn tối đa ≈ 11 ms; 10 000 record (20 envelope, 5,3 MB) → parse ≈ 25 ms + lọc ≈ 65 ms tổng, chặn tối đa ≈ 5 ms (ngưỡng 50 ms). Integration (`realtime-batch.int.test.ts`): `PATCH` bulk 1 000 record, 5 lần, 4 tab (editor, reader, sales1, sales2) trên 2 instance: editor/reader/sales2 mỗi lần đúng 1 message, sales1 10 message từng record; từ lúc HTTP trả lời tới message cuối: p95 ≈ 4–45 ms (máy rảnh / máy tải cao; cả lần ghi 1 000 record: p50 ≈ 0,5–2,9 s). E2E (`t204-realtime.spec.ts`, Playwright): bulk `PATCH` 1 000 Orders → tab editor nhận 1 frame `record.batch`, tab sales1 1 frame; grid tab kia hiện giá trị mới sau HTTP trả lời p95 ≈ 120 ms (refetch block).
- **Link chéo table (T402)**: record đổi primary / vào-ra thùng rác → `RecordMutationService` gọi `records/links/link-fanout.ts` trong cùng transaction: với mỗi field link trỏ tới table đó, tìm record nguồn còn sống qua junction, chụp ảnh (field rule/view + ô link trước/sau) và (≤ 100 record) ô mới kèm title; sau commit phát `record.changes` của table nguồn với `event_id: null`, cờ `link_fanout` (C§7). Ảnh record thường cũng mang ô link khi filter đã lưu của view hoặc record rule của role (T710) nêu field link (`records/links/link-images.ts`), để realtime theo view và theo read rule đúng; record đích vào/ra thùng rác → fan-out này đánh giá lại read rule link của từng subscriber.
- **Giá trị computed tính lại (T459)**: hook mặc định `afterRecompute` của `ComputedRecomputeService` (`realtime/computed-values.ts`, không hoạt động khi không có bus) đọc trong transaction đã ghi các record còn sống có giá trị đổi (`__version`, field rule/filter view — gồm field computed `stored`, giá trị cũ lấy từ `RETURNING` của `UPDATE` tính lại —, ô link của ảnh, giá trị `cell_format=json` kèm title record/tên member) và đăng ký phát **sau** mọi hook commit khác của transaction (`afterCommit(…, { last: true })`), nên message của lần ghi gây ra tới trước; mỗi lần gọi (một lần ghi đồng bộ hoặc một lô job) là một lần ghi `record.changes` `event_id: null` mỗi table. Field meta của envelope mang `result_type` và tham chiếu (T457 `computedReferences`) để `RecordDeliveryStrategy` xếp field theo từng nhóm: `locked` (như field ẩn), `scoped` (record rule trên table nguồn → `record.batch`, không giá trị, điều kiện view trên field đó bỏ qua), `plain`. Ảnh của mọi ghi thường (`RecordMutationService`, trước commit) được bổ sung field computed `stored` nêu trong filter view/rule (`ComputedImages`) với giá trị trước lần tính lại của cùng transaction (nhật ký theo transaction), và ảnh của ghi hệ thống (job `auto_number`, xoá option, đổi kiểu) được bổ sung ô link mà filter view nêu. `computed.recomputing` từ hook `onProgress` của job `computed.backfill`/`computed.recompute`. Primary field đổi `options`/kiểu hoặc `auto_number` của primary được tính lại → `RealtimeSchemaChangePublisher` (có `db`) / job gọi `publishLinkTitlesChanged`: `LinkFanout` với mọi record nguồn (không mang giá trị) → `record.batch` cho các table nguồn. Bật/tắt `strict_computed_permissions` → `schema.changed` cho mọi field computed của base. Chi tiết: CONTRACTS §7.
- **API token (T706, ADR-36 §2)**: bắt tay có `Authorization` dùng cùng `ApiTokenAuthService` với HTTP (cùng mã `401`, giới hạn thất bại theo IP); kết nối giữ principal `api_token`, nên `AccessService` áp `base_ids`/org của token và mọi strategy lọc như subscriber cookie. Instance nghe bus của org token từ lúc bắt tay; envelope `api_token.revoked` được router xử lý ngay (ngoài hàng đợi của org) để đóng `4401`; mỗi 60 s và trước mỗi lần kiểm lại do `permission.changed`, gateway xác thực lại token (hết hạn, user rời org). Chi tiết: CONTRACTS §7, §26.5.
- Metrics: gauge `ws_connections{auth = session | api_token}`, `ws_subscriptions`, `realtime_bus_organizations` (không label org/user/token).
- Định dạng message: CONTRACTS §7 (nguồn chuẩn). Message record là **patch theo field** (`record.updated` với `channel`, `record_id`, `version`, `fields`). Server lọc field theo quyền **từng subscriber** trước khi gửi; record không còn khớp record rule → gửi `record.removed_from_view`.
- Xung đột: last-write-wins theo ô; client bỏ patch có `version` ≤ version đang giữ.
- Đổi schema/view → server gửi `schema.changed` (C§7) → client invalidate query tương ứng.
- Mục tiêu độ trễ < 1s p95.

---

## 15A. Chia sẻ bằng link (share links)

Giống Lark Base: tạo link cho **view** (grid/kanban, chỉ đọc), **form** (gửi dữ liệu), **dashboard** (chỉ đọc + filter control).

### 15A.1 Mô hình
- Bảng `meta.share_links` (§5.10). `target_type`: `view | form | dashboard`. Một target có tối đa 1 link chưa thu hồi (link tắt vẫn tính; tạo lại = thu hồi link cũ).
- `audience`:
  - `org` — ai đăng nhập vào org và có link đều xem được (kể cả không phải thành viên base).
  - `public` — bất kỳ ai trên internet.
- Link chỉ tạo được bởi base owner, role `admin`, hoặc role có `base_rule.share_link = true` (role `editor` hệ thống mặc định `true`, `reader` mặc định `false` — §14.1); đồng thời người tạo phải có quyền đọc target (view/form/dashboard). Org admin có cài đặt `settings.public_sharing`: cấm hoàn toàn `public`, hoặc chỉ cho `public` với form (chi tiết, số phận link public đang bật: CONTRACTS §16).
- `settings`:
```json
{
  "allow_download": false,
  "allow_export": false,
  "allow_copy": false,
  "allow_search": true,
  "allow_viewer_filter_sort": true,
  "show_record_detail": true,
  "embed": { "enabled": false, "allowed_origins": [] },
  "dashboard": { "allow_filter_controls": true, "refresh_seconds": 60, "tv_mode": false }
}
```
- `allow_download` (từ S4, T409 — Câu hỏi mở S4 #3, ghi chú ở Quyết định S3 #7): **chỉ** cho tải tệp đính kèm qua link (field attachment trong phạm vi và thuộc `file_download_fields` của người tạo); export qua link dùng key riêng `allow_export` (dưới). Thumbnail xem được khi field trong phạm vi, không cần cờ này.
- `allow_export` (S7, T810 — Quyết định S7 #17; mặc định `false`): người có link export được **cả view** (CSV/XLSX như §17) theo quyền **hiện tại** của người tạo ∩ view (filter view, field ẩn bị bỏ, read rule người tạo) và chỉ khi người tạo **đang** có `base_rule.download`; theo view đã lưu (không theo filter tạm của người xem), trần `EXPORT_MAX_ROWS`, 1 export/link + 1/IP, audit `export.created` actor `share_link`. Chỉ link view (form → `422`); dashboard: CSV widget qua link (T808/T809). Chi tiết: CONTRACTS §16A.
- Mật khẩu tuỳ chọn (argon2id), hết hạn tuỳ chọn, bật/tắt, thu hồi, tạo lại token.

### 15A.2 Quyền của người xem qua link (bắt buộc)
Principal loại `share_link`. Quyền hiệu lực = **giao** của:
1. Quyền hiện tại của `created_by` (tính lại mỗi request — người tạo mất quyền → link ngừng hoạt động, trả 410).
2. Phạm vi của target: đúng view đó (filter của view luôn áp dụng, người xem không gỡ được; field ẩn trong view = không trả về) / đúng các widget của dashboard / đúng các field của form.
3. Luôn chỉ đọc (trừ form: chỉ create).

Người xem chỉ được thêm filter/sort **bên trên** filter của view nếu `allow_viewer_filter_sort`. Không có API nào qua link trả field ngoài phạm vi, kể cả qua lookup, record detail, export, attachment, dashboard click-through.

UI tạo link MUST hiển thị cảnh báo rõ: số record và danh sách field người ngoài sẽ thấy.

### 15A.3 URL & API
- Trang: `/s/{token}` (token 32 byte base64url, lưu hash SHA-256, `token_prefix` 6 ký tự để admin nhận diện).
- API: `/api/v1/shares/{token}/meta`, `/records/query`, `/records/group-counts` (T317), `/records/{id}`, `/unlock`, `/submit-token` + `/submit` (form, C§17), `/submission-status` + `/members` (form, T321: trạng thái giới hạn nộp; người cho câu hỏi field user — chỉ link `org`, `{ id, display_name }`; link public ẩn câu hỏi người, C§17); `/dashboard` + `/widgets/{id}/data|options|export` (T809: link dashboard, C§16A), `/files/{attachmentId}` + `/files/{attachmentId}/thumbnail` (T409: tải khi `allow_download` và field thuộc `file_download_fields` của người tạo; thumbnail chỉ cần field trong phạm vi; C§16A), `/export` (T810: cần `allow_export` + `download` hiện tại của người tạo; C§16A).
- Link có mật khẩu: `POST /api/v1/shares/{token}/unlock` → cookie phiên riêng cho link (HttpOnly, 24h; CSRF: CONTRACTS §12.0). Sai 5 lần/15 phút/IP (theo link) → khoá tạm + audit. Contract đầy đủ: CONTRACTS §16A.
- Embed (T809): chỉ link `public` không mật khẩu. Trang `/s/{token}?embed=1` có `Content-Security-Policy: frame-ancestors <allowed_origins>` theo link — nginx hỏi API (`GET /api/v1/shares/{token}/page`) rồi phục vụ `share.html` qua `X-Accel-Redirect` với header API trả; link không nhúng được → `frame-ancestors 'none'` + `X-Frame-Options: DENY`; mọi trang khác `frame-ancestors 'none'`. URL embed ẩn khung điều hướng (C§16A **Nhúng**).
- Header cho trang share: `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`.
- Rate limit: đọc 20 req/s/IP (như §13.1, đủ để cuộn grid chỉ đọc), `unlock` sai 5 lần/15 phút/IP → khoá tạm, form submit 10/phút/IP; tệp và thumbnail qua link (T409) 120 request/10 s/IP; upload ẩn danh qua link form (T410) 20/10 phút/IP, tối đa 10 tệp/câu và 100 MB/lần nộp (C§16A, C§17).
- Dashboard qua link: làm mới bằng polling theo `refresh_seconds` (30..3600 s); realtime qua WS cho share link là Phase 2. Widget qua link: 120 request/10 s/IP (T809).

### 15A.4 Quản trị & audit
- Audit: tạo/sửa/thu hồi/tạo lại link, đổi audience, mở khoá sai mật khẩu nhiều lần.
- Thống kê truy cập gộp theo ngày (không log IP chi tiết quá 30 ngày).
- Trang admin org: danh sách mọi link đang bật (target, audience, người tạo, lần truy cập cuối), thu hồi hàng loạt.

## 16. File storage

- S3-compatible (ADR-16: **Garage** mặc định trong profile `full`; hỗ trợ mọi S3: AWS, R2, SeaweedFS, MinIO bản thương mại…), bucket cấu hình qua env (mặc định `cellhive`). Profile `minimal` dùng `STORAGE_DRIVER=local` (lưu file vào volume, API tự ký URL tải/upload ngắn hạn thay presigned S3). Code chỉ dùng tập S3 API mà Garage hỗ trợ (PUT/GET/HEAD/DELETE object, multipart, presigned URL, CORS bucket); không dùng versioning, object lock, lifecycle. Object key: `{organization_id}/{attachment_id}` (driver chấp nhận key khớp `^[A-Za-z0-9_]+/[A-Za-z0-9_.-]+$`, ≤ 512 ký tự, không có đoạn `.`/`..`) (không đưa filename/record_id vào key — tránh lỗi Unicode, record có thể bị copy/di chuyển). Filename lưu ở `meta.attachments`.
- Upload (T406, C§20): client xin presigned PUT (hết hạn 10 phút, ký cả `Content-Type` và `Content-Length` đúng kích thước khai báo — S4 #13; driver `local`: URL ký của API, nhận stream, không đệm cả file) → PUT trực tiếp object storage → gọi `complete` → server HEAD kiểm size, đọc stream một lần để sniff magic bytes và tính sha256; sai → xoá object + `422` → gắn vào ô bằng ghi record `[{ id }]`. Trần `ATTACHMENT_MAX_FILE_BYTES` (mặc định 100 MB), whitelist `accept` và danh sách chặn `blocked_extensions` của field (mặc định: tệp thực thi, admin chỉnh được — Quyết định thiết kế S4 #6); lớp bảo vệ chính là cách phục vụ tệp (dòng Download).
- Bản sao ô sang record khác (dán, nhân bản) = dòng `meta.attachments` mới chung `object_key`; object chỉ bị xoá khi không còn dòng nào trỏ tới (S4 #12). Gỡ khỏi ô giữ tệp 30 ngày (undo, khôi phục lịch sử); upload không gắn bị xoá sau 24h (cron `attachments.cleanup`).
- Download: qua API kiểm tra quyền đọc record + field + `file_download_fields` mỗi lần → 302 presigned GET 60s, `Content-Disposition` với filename UTF-8 (RFC 5987); chỉ `inline` cho ảnh raster (png/jpeg/gif/webp) và audio/video (xem bằng `<video>`/`<audio>`, driver `local` hỗ trợ `Range`), còn lại `attachment`; driver `local` (cùng origin) thêm `X-Content-Type-Options: nosniff` + `Content-Security-Policy: sandbox`. Log không có filename, key, URL ký.
- Thumbnail ảnh (T407, C§20): job `file.thumbnail` (worker, `sharp` — Apache-2.0, libvips LGPL-3.0-or-later liên kết động qua gói prebuilt `@img/sharp-libvips-*`) sau `complete` cho png/jpeg/gif/webp ≤ 50 MB và ≤ 50 MP (chống decompression bomb; lớn hơn → bỏ qua, attachment vẫn dùng được), WebP 256 và 1280 px ở key `{object_key}_t<size>`, xoá cùng object. `GET /files/:id/thumbnail` chỉ cần quyền **đọc** record + field (không cần `file_download_fields`: "xem vẫn được", §14.1). Trang đầu PDF không làm (cần thêm poppler/pdfium vào image — ngoài phạm vi).
- Record bị xoá cứng (xoá vĩnh viễn trong thùng rác hoặc cron `records.purge` sau 30 ngày, T408) → tệp được đánh dấu, cron `attachments.cleanup` xoá object khi không còn dòng nào tham chiếu (C§11.3, C§20).

---

## 17. Import / Export (bản 0.1 thiếu — bắt buộc cho MVP)

- Import CSV (UTF-8, UTF-8 BOM, Windows-1258 phát hiện tự động) và XLSX (sheet đầu hoặc chọn sheet), tối đa 50.000 dòng/lần.
- Hai chế độ: tạo table mới (đoán kiểu field từ 200 dòng đầu, user xác nhận) hoặc append vào table có sẵn (map cột → field).
- Chạy dạng job, báo tiến độ qua realtime `user:{id}`, trả báo cáo dòng lỗi (dòng sai bị bỏ qua, job tiếp tục; huỷ giữa chừng; table mới bị đưa vào thùng rác khi job thất bại/bị huỷ). Giới hạn file 50 MB, cột ≤ ngân sách field (Quyết định S3 #6). Contract chi tiết: CONTRACTS §19 (T308); upload tạm ở bảng `meta.imports` (migration 0010).
- Mỗi record import sinh event `record.created` như ghi thường (import chỉ tạo record, C§19); audit có `batch_id = job_…` và `via.import_job_id`. Trường `batch` trên event có từ S5 (ADR-26): automation có `skip_bulk` bỏ qua cả lần import, automation khác chạy tối đa `AUTOMATION_MAX_RUNS_PER_BATCH` run, breaker tính cả lần import là một đơn vị.
- Export CSV/XLSX theo view (tôn trọng filter/sort/hidden fields và quyền), ghi audit. Stream đồng bộ `GET /tables/:id/export`, 1 export đang chạy/user, trần `EXPORT_MAX_ROWS` — contract ở C§18.
- Link, `parent`, attachment (T411, Câu hỏi mở S4 #15): export ô link/`parent` = title record đích **người export đọc được** (liên kết không đọc được bị bỏ, không in id), attachment = tên tệp (không URL); import append nhận field link/`parent` theo title (khớp chính xác, duy nhất trong phạm vi đọc, áp `record_filter`, ≤ 500/ô; mơ hồ → lỗi dòng `LINK_TARGET_AMBIGUOUS`), không import vào attachment; `create_table` không đoán kiểu link/attachment (C§18, C§19).

### 17.1 Xuất/nhập nguyên một base (ADR-24)
- Gói `.chbase` (zip): manifest + checksum, schema (table, field, view, dashboard, automation, role custom), dữ liệu NDJSON theo field id, junction link, file đính kèm.
- Không xuất thùng rác, audit, lịch sử, share link, token, secret, thành viên/gán role.
- Nhập: sinh ID mới cho mọi đối tượng và viết lại mọi tham chiếu (formula, filter, lookup, view, widget, automation, role); user ánh xạ theo email; automation nhập ở trạng thái tắt, phải gắn lại secret; chạy như job, lỗi giữa chừng thì dọn sạch.
- Chỉ base owner/admin được xuất. Giải nén có giới hạn chống zip bomb và path traversal.

---

## 18. i18n & bản địa hoá

- UI i18n (i18next): `en` là ngôn ngữ gốc, `vi` dịch đầy đủ trong MVP; cấu trúc cho phép cộng đồng thêm ngôn ngữ chỉ bằng file JSON (Phase 2: tích hợp Weblate/Crowdin). Không hard-code chuỗi hiển thị.
- Locale, timezone, tiền tệ mặc định cấu hình ở org và user; giá trị mặc định lấy từ env lúc cài (`DEFAULT_LOCALE`, `DEFAULT_TIMEZONE`, `DEFAULT_CURRENCY`), không hard-code Việt Nam trong code.
- Collation text theo locale của base (`meta.bases.settings.collation`, mặc định `und-x-icu`; chọn `vi-VN-x-icu` cho tiếng Việt). Collation đặt lúc tạo cột; đổi collation = job rewrite như đổi kiểu field.
- Tìm kiếm & contains/starts/ends không dấu, không phân biệt hoa thường (`meta.f_unaccent(lower())`) — có ích cho mọi ngôn ngữ Latin có dấu, không riêng tiếng Việt.
- Định dạng số/tiền/ngày theo `Intl` của locale; tiền tệ theo ISO 4217 với số lẻ chuẩn (VND = 0, USD = 2).

---

## 19. Observability & vận hành

- Log JSON (pino) có `request_id`, `org_id`, `user_id`, `run_id`. Không log giá trị record, secret, token. Serializer `err` của logger API và worker bỏ `detail`/`hint`/`where`/`internalQuery` của lỗi PostgreSQL ở mọi mức `cause` (có thể trích dòng dữ liệu, vd "Failing row contains …") — giữ SQLSTATE, table, constraint, message (T616).
- OpenTelemetry traces (HTTP, DB, job); metrics Prometheus tại `/metrics` (api; worker chưa có `/metrics` — bộ đếm trong tiến trình worker như `http_deliveries_total` chưa phơi được, S9): request latency, job queue depth, job fail, automation run theo status, WS connections.
- Health: `/healthz` (liveness), `/readyz` (Postgres + Valkey + storage).
- Webhook vào (T603, C§25.2): `webhook_requests_total{result}`, histogram `webhook_request_duration_seconds{result}`, `automation_causation_rejected_total{reason}` (api).
- `/metrics` không public: yêu cầu `Authorization: Bearer <METRICS_TOKEN>` hoặc chỉ bind vào cổng nội bộ (`METRICS_PORT`); không gắn label theo org/user (tránh cardinality cao và lộ tên tenant).
- HTTP ra (T605, C§25.5): gauge `http_delivery_oldest_pending_seconds` (API, đọc DB khi scrape) — **gợi ý cảnh báo > 600 s** (outbox kẹt: worker dừng, đích chậm kéo dài, Valkey lỗi); `http_deliveries_total{outcome}`, `http_delivery_duration_seconds` và `http_ssrf_blocked_total{reason}` của job `http.deliver` đếm trong process worker — worker chưa phơi `/metrics` (BACKLOG "Tồn đọng S5c", S9). Cứu dòng giao (T702, ADR-36 §5, C§25.5): cron `http.deliveries_rescue` mỗi phút thêm lại job cho dòng giao mất job, counter `http_deliveries_rescued_total` (đếm trong worker như trên). Job của worker chết: mỗi tiến trình worker khoá job bằng id `ob-<hostname>-<pid>-<8 base62>` và lúc khởi động (trước khi nhận job) mở khoá ngay job của id khác cùng hostname **có tiến trình đã chết** — mỗi tiến trình giữ suốt đời một advisory lock cấp session của PostgreSQL theo id của mình (kết nối riêng, tự lấy lại khi kết nối rớt), lock trống = đã chết; không dùng pid nên đúng cả khi nhiều PID namespace chung một hostname (container cùng pod, `hostname:` cố định, `network_mode: host`) — tiến trình còn sống (vd `pnpm dev`: api `MODE=all` cạnh `apps/worker`) giữ khoá; nhiều replica khác hostname không mở khoá của nhau — job của replica chết chờ mốc khoá 4 giờ của graphile-worker (hoặc người vận hành chạy `graphile_worker.force_unlock_workers`).
- OIDC (T707, C§27.2): `oidc_callbacks_total{provider,result}` (api). Secret gắn host (T701, C§25.5): `http_secret_host_blocked_total{reason}` đăng ký ở `/metrics` của API nhưng lần chặn thật đếm trong worker (cùng giới hạn trên). Kết nối giữ advisory lock liveness của worker phải đi thẳng tới PostgreSQL — lock cấp session không dùng được qua PgBouncer chế độ transaction (QA S6 L7; tài liệu self-host S9).
- App kiểm tra `server_version_num >= 180000` lúc khởi động (ADR-19).
- Backup: tài liệu hoá `pg_dump` (bao gồm schema `data`) + mirror bucket (`rclone sync`) hoặc thư mục local; script restore kiểm thử trong CI hằng tuần (Phase 1.5).
- Grafana/Loki/Prometheus: file compose tuỳ chọn `docker-compose.observability.yml`.

---

## 20. Docker Compose

Mục tiêu tài nguyên: toàn bộ stack chạy được trên máy 2 vCPU / 2 GB RAM cho nhóm ≤ 20 user (đo trong S9).
Hai profile compose:
- `minimal`: `web`, `api`+`worker` (có thể chạy chung một process bằng `MODE=all`), `postgres`, `valkey`; file lưu local volume.
- `full`: như dưới.

Services: `web` (nginx phục vụ static SPA + reverse proxy `/api`, `/ws`), `api`, `worker`, `postgres:18`, `valkey/valkey:8`, `garage` (profile `full`) + one-shot `storage-init` (tạo layout một node, bucket, access key, CORS — Garage không tự làm những việc này).
- Migration meta chạy bằng lệnh `api migrate` như một one-shot service trước `api`/`worker`.
- Mọi cấu hình qua env; có `.env.example` đầy đủ, validate env bằng zod lúc khởi động (thiếu → không start). Danh sách **chuẩn** (thêm biến = sửa bảng này):

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `NODE_ENV` | | `production` | |
| `MODE` | | `api` | `api` \| `worker` \| `all` \| `migrate` |
| `PORT` | | `3000` | cổng HTTP của api |
| `PUBLIC_URL` | ✓ | | URL gốc người dùng truy cập (link mời, reset, share, CORS mặc định); URL webhook vào (`…/api/v1/hooks/<token>`), host của token causation (C§10), chế độ webhook Telegram (chỉ khi https cổng 443/80/88/8443 — C§22.7) |
| `DATABASE_URL` | ✓ | | Postgres 18 |
| `DATABASE_POOL_MAX` | | `10` | |
| `CACHE_URL` | ✓ | | Valkey (`redis://` hoặc `rediss://`) |
| `STORAGE_DRIVER` | | `local` | `local` \| `s3` |
| `STORAGE_LOCAL_PATH` | | `/data/files` | khi `local` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | khi `s3` (trừ `S3_ENDPOINT`: trống = AWS) | path style `true`; compose đặt bucket `cellhive` | endpoint mà api/worker dùng (mạng nội bộ) |
| `ATTACHMENT_MAX_FILE_BYTES` | | `104857600` | trần kích thước một tệp đính kèm (§14.2, §16, C§20; 1 byte…5 GiB — một presigned PUT); vượt → `422 FILE_TOO_LARGE` khi xin upload |
| `S3_PUBLIC_ENDPOINT` | | = `S3_ENDPOINT` | endpoint **trình duyệt** dùng cho presigned URL; phải truy cập được từ client (vd subdomain `files.example.com` reverse proxy tới Garage). Không proxy theo path con của `PUBLIC_URL` vì chữ ký SigV4 gắn với host và path |
| `STORAGE_PUBLIC_ORIGIN` (container `web`) | | trống | origin của `S3_PUBLIC_ENDPOINT`, được nginx thêm vào CSP (`img-src`, `media-src`, `connect-src`) để trình duyệt upload/xem tệp (T418, F§10.5); compose đặt từ `S3_PUBLIC_ENDPOINT`; để trống với `STORAGE_DRIVER=local` |
| `APP_MASTER_KEY` | ✓ | | 32 byte base64, mã hoá `meta.secrets` (AES-256-GCM) |
| `SESSION_SECRET` | ✓ | | ≥ 32 byte, HMAC cho CSRF token và URL ký của storage local |
| `COOKIE_SECURE` | | `auto` | `auto` \| `true` \| `false` |
| `TRUSTED_PROXIES` | | `127.0.0.0/8,::1/128,172.16.0.0/12` | danh sách CIDR (mặc định: loopback + dải mạng bridge mặc định của Docker) |
| `CORS_ORIGINS` | | `PUBLIC_URL` | danh sách origin |
| `OIDC_PROVIDERS` | | | Đăng nhập OIDC (ADR-36 §3, C§27): slug provider `[a-z0-9-]{1,32}` cách bằng dấu phẩy, ≤ 10; trống = chỉ mật khẩu. Mỗi slug cấu hình bằng các biến `OIDC_<SLUG>_*` dưới (slug viết hoa, `-` → `_`); biến của slug không có trong danh sách bị bỏ qua |
| `OIDC_<SLUG>_ISSUER` | ✓ (mỗi slug) | | issuer (discovery `/.well-known/openid-configuration`); `https://`, `http://` chỉ khi `NODE_ENV=development`; không userinfo/query/fragment |
| `OIDC_<SLUG>_CLIENT_ID`, `OIDC_<SLUG>_CLIENT_SECRET` | ✓ (mỗi slug) | | client bí mật (`client_secret_basic`); `CLIENT_ID` ≤ 255 ký tự, `CLIENT_SECRET` ≤ 1.024 ký tự; secret không bao giờ được log |
| `OIDC_<SLUG>_NAME` | | slug | nhãn nút đăng nhập, ≤ 100 ký tự |
| `OIDC_<SLUG>_SCOPES` | | `openid email profile` | cách bằng khoảng trắng và/hoặc dấu phẩy, trùng bỏ; phải có `openid` |
| `OIDC_<SLUG>_ALLOW_SIGNUP` | | `false` | tạo tài khoản cho người chưa có khi email đã xác minh (JIT) |
| `OIDC_<SLUG>_ALLOWED_DOMAINS` | | (mọi domain) | domain email được tạo tài khoản, cách bằng dấu phẩy (khớp đúng domain, không gồm subdomain) |
| `OIDC_<SLUG>_LINK_BY_EMAIL` | | `false` | liên kết với user có sẵn cùng email đã xác minh (T708); chỉ bật cho IdP tin được về email |
| `OIDC_<SLUG>_AUTO_JOIN_ORG` | | | slug org (`[a-z0-9-]{1,100}`) mà tài khoản mới tự vào với role `member`; org không tồn tại → bỏ qua + log |
| `SMTP_URL`, `SMTP_FROM` | | trống = tắt email |`smtp://[user:pass@]host[:port]` (STARTTLS bắt buộc) hoặc `smtps://` (TLS); không path/query. SMTP cấp instance dùng cho email hệ thống, thông báo, automation (C§23) |
| `SMTP_ALLOWED_FROM_DOMAINS` | | domain của `SMTP_FROM` | danh sách domain (IDN → punycode) mà SMTP instance được gửi làm `From` (danh tính `send_as`, ADR-33); relay phải ký DKIM cho các domain này |
| `SMTP_ALLOW_INSECURE` | | `false` | `true` = cho SMTP không TLS (STARTTLS khi có, không bắt buộc) — chỉ cho dev |
| `EMAIL_MAX_PER_HOUR_PER_ORG` | | `500` | email automation + thông báo mỗi org mỗi giờ (đồng hồ, Valkey); vượt → chờ giờ sau, quá 24h → `email_quota_exceeded` (C§23); Valkey chưa kết nối (vừa khởi động, đang kết nối lại) → chờ tối đa 3 s rồi lỗi tạm `smtp_temporary` (retry, T541); 1–1.000.000 |
| `EMAIL_MAX_RECIPIENTS` | | `50` | to + cc + bcc một thư (1…500); vượt → `too_many_recipients`, không gửi gì |
| `SMTP_MAX_PER_SEC` | | `5` | thư mỗi giây mỗi process (api/worker); 1–1.000; **cửa sổ trượt 1 giây** tính trên cả giao dịch SMTP (T541): một thư giữ lượt từ lúc bắt đầu gửi tới 1 giây sau khi xong, nên mọi khoảng 1 giây trượt — kể cả theo giờ máy chủ SMTP nhận — có tối đa giá trị này thư (burst = giá trị, không 2×); 50 thư với giá trị 5 ≈ 9–10 s (T541 đo 10,5 s ở load 94 — máy bận, ngoài quy ước < 8 —, tối đa 5 thư trong một giây trượt; T528 đo 10 thư khi chỉ đếm lượt bắt đầu) |
| `EMAIL_TEST_SEND_PER_MIN` | | `5` | thư thử ("Kiểm tra kết nối", gửi thử automation) mỗi user mỗi phút; 1–1.000 |
| `EMAIL_MAX_HTML_BYTES` | | `102400` | trần phần HTML (1 KiB…1 MiB); vượt → `email_body_too_large` |
| `SMTP_ALLOW_PRIVATE_HOSTS` | | `false` | `true` = danh tính gửi được dùng máy chủ SMTP riêng ở địa chỉ private/loopback/link-local (mail server trong LAN, vd `mail.example.lan`); địa chỉ metadata cloud luôn bị chặn (§14.3, ADR-33 §1A) |
| `EMAIL_MAX_PER_HOUR_PER_IDENTITY` | | `100` | thư mỗi giờ (đồng hồ, Valkey) qua máy chủ SMTP riêng của một danh tính, ngoài trần org (T530); 1–1.000.000 |
| `EMAIL_AUTOMATION_FOOTER` | | `required` | `required` = thư automation luôn có footer (`minimal`/`full`) ở mọi org; `org` = theo `organizations.settings.email.footer_policy` của từng org (`author_choice` cho phép `footer: none` khi gửi bằng danh tính `send_as` đã xác minh). Instance một org tự host có thể đổi sang `org` (C§23.4, ADR-33 §4, T531) |
| `EMAIL_MAX_ATTACHMENTS` | | `10` | số tệp đính kèm tối đa một thư automation (1…20); org admin đặt thấp hơn/bằng trong Cài đặt email (`max_attachments`, C§23.2); vượt → bước `failed` `too_many_attachments` (T532) |
| `EMAIL_MAX_INLINE_IMAGES` | | `5` | số ảnh nhúng CID tối đa của một thư automation, kể cả logo chữ ký (1…20); byte ảnh tính chung `EMAIL_MAX_ATTACHMENT_BYTES`; vượt → `too_many_attachments` (`params.scope = inline_images`), không gửi (T534) |
| `EMAIL_MAX_ATTACHMENT_BYTES` | | `15728640` | tổng byte tệp gốc đính kèm một thư automation (1 MiB…30 MiB); org đặt ≤ trần (`max_attachment_bytes`); vượt → `attachments_too_large`, không cắt bớt tệp; toàn thư sau mã hoá ≤ 25 MiB (hoặc mức trần instance cần khi được nâng) (T532) |
| `DEFAULT_LOCALE`, `DEFAULT_TIMEZONE`, `DEFAULT_CURRENCY` | | `en`, `UTC`, `USD` | giá trị cho org mới |
| `ALLOW_ORG_CREATION` | | `false` | `true` cho phép user đã đăng nhập tạo org mới qua API |
| `MAX_FIELDS_PER_TABLE` | | `500` | ADR-20 |
| `COMPUTED_FIELDS_MAX_PER_BASE` | | `200` | §9.5 (T456): số field formula + lookup đang hoạt động tối đa mỗi base (1…10.000) |
| `AUDIT_RETENTION_DAYS` | | `365` | ADR-23 |
| `EXPORT_MAX_ROWS` | | `1000000` | trần số dòng một lần export CSV/XLSX (§17, C§18; 1…10.000.000); vượt → `422` trước khi stream |
| `AUTOMATION_MAX_RUNNING_PER_ORG` | | `5` | ADR-18; 1–1.000 |
| `AUTOMATION_MAX_RUNS_PER_BATCH` | | `1000` | ADR-26; trần run mỗi automation mỗi lô, 1–`50000` (S5) |
| `AUTOMATION_RUN_RETENTION_DAYS` | | `90` | T518; cron `automation.runs_cleanup` (hằng ngày 02:45 UTC) xoá run automation đã kết thúc cũ hơn (kèm bước), theo lô theo org (1–3650) |
| `HTTP_PRIVATE_ALLOWLIST` | | `org` | HTTP ra của automation (§14.3, ADR-35 §3, T600): `org` = mục allowlist của org mở được địa chỉ private (vd n8n nội bộ; loopback chỉ khi nêu đúng host + cổng); `off` = allowlist chỉ mở cổng khác trên host công khai, không bao giờ tới địa chỉ private — đặt `off` khi nhiều org không tin nhau dùng chung instance; metadata cloud luôn bị chặn |
| `WEBHOOK_MAX_RATE_PER_SEC` | | `50` | §13.2; trần `rate_limit_per_sec` của từng incoming webhook (1–1.000; burst 4×; trần base 50 req/s không đổi theo env — C§25.6) |
| `NOTIFICATION_RETENTION_DAYS` | | `90` | ADR-29; cron `notifications.cleanup` (hằng ngày 02:30 UTC, T511) xoá `meta.notifications` cũ hơn (1–3650) |
| `WORKER_CONCURRENCY` | | `5` | số job một tiến trình worker chạy cùng lúc (1–1.000). Lời gọi HTTP ra của automation dùng tối đa `max(1, WORKER_CONCURRENCY − 1)` slot (ADR-35 §4 Sửa đổi T616) — tăng giá trị này khi automation gọi đích chậm (mỗi lời gọi giữ một slot tới 10 s), để job khác không phải chờ |
| `LOG_LEVEL` | | `info` | |
| `METRICS_TOKEN` / `METRICS_PORT` | | trống | §19 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | | trống = tắt | không có telemetry mặc định |

Biến **chỉ compose dùng** (không đọc bởi app, nằm ở phần comment cuối `.env.example`): `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` (profile `full`), `CELLHIVE_VERSION`, `HTTP_PORT`. Service `migrate` chạy trước app ở cả hai profile.
- Không yêu cầu Kubernetes. Helm chart: Phase 2 (nhận đóng góp cộng đồng).
- Có sẵn `docs/en/self-hosting.md`: cài, cấu hình reverse proxy + HTTPS, backup/restore, nâng cấp, biến môi trường.

---

## 21. Hiệu năng (mục tiêu kỹ thuật, kiểm bằng test k6/bench trong Sprint cuối)

Tập dữ liệu chuẩn: 1 table 200.000 record, 30 field, 2 link.
- API thường p95 < 300 ms; query record (filter + sort, limit 200) p95 < 500 ms.
- Grid cuộn mượt với table 200.000 dòng (windowed load, không tải hết về client).
- Dashboard 5 widget load lần đầu < 2s (chưa cache).
- Realtime p95 < 1s.
- Không mất event khi kill worker giữa chừng (test chaos đơn giản).

---

## 22. Lộ trình (sprint 2 tuần)

Nguyên tắc sắp xếp: **permission skeleton, event/job, audit, realtime phải có từ sớm** — bản 0.1 để RBAC ở sprint 8 và realtime ở sprint 9 là sai, vì retrofit hai thứ này vào mọi endpoint/màn hình tốn gấp nhiều lần.

| Sprint | Nội dung | Kết quả kiểm được |
|---|---|---|
| S0 | Monorepo, file cộng đồng + LICENSE AGPL + DCO check + kiểm license (`pnpm licenses:check`) trong CI (§1A), CI (lint, typecheck, test với Testcontainers Postgres), Docker Compose, env validation, auth (password + session), org/workspace/base CRUD, `packages/permissions` với role cấp org/workspace/base, audit writer, `meta.events` + graphile-worker + job `events.dispatch` rỗng | Login, tạo base, audit ghi được, job chạy qua restart |
| S1 | `SchemaService` (DDL an toàn, ngân sách cột), table/field CRUD với field MVP (trừ link/lookup/formula/attachment), `packages/field-types`, `packages/filter-dsl` (compile + evaluate + test tương đương), RecordQuery/Mutation services **có áp record_rule + field_rule**, API role custom, record REST API, OpenAPI | Tạo table/field/record qua API, filter/sort đúng; P01–P19, P25–P27 xanh |
| S2 | Grid (glide-data-grid): windowed load, inline edit, thêm/sửa field, copy/paste, fill-down, expand record, soft delete + thùng rác; realtime record patches | Hai tab trình duyệt thấy nhau sửa realtime |
| S3 | Views đã lưu (filter/sort/group/hide/order/width), Kanban, Form, hạ tầng share link (§15A) dùng cho form + view chỉ đọc, import CSV/XLSX, export | Tạo form public, dữ liệu vào grid |
| S4 | Link một/hai chiều + đổi chiều một chiều ↔ hai chiều (ADR-28), tối đa 500 liên kết/ô, bảng con nhúng trong record detail, sub-records (cây), attachments, đổi kiểu field + backfill job, đổi style text → email/phone báo số ô không hợp lệ (§5.5) | Đơn hàng ↔ chi tiết đơn hàng, task có sub-task dạng cây; đổi link Đơn hàng → Khách hàng từ một chiều sang hai chiều giữ nguyên mọi liên kết và quay lại được; liên kết thứ 501 của một ô bị từ chối `TOO_MANY_VALUES`; đổi style sang email không mất giá trị nào, preview báo đúng số ô sai định dạng |
| S4b | Formula engine (parser, typecheck, SQL compiler, TS evaluator, hàm `fx.*`, gồm các hàm bổ sung §9.3), lookup bốn thành phần + `style` định dạng kết quả, dependency graph + tính lại stored/virtual, trạng thái lỗi cấp field phân biệt `#REF` (field tham chiếu bị xoá) và `#CIRCLE` (lỗi từng ô vẫn `NULL`, §9.4), formula editor | Công thức cross-table kiểu Lark chạy đúng, test tương đương TS/SQL pass (kể cả `LET`, `LOOKUP`, `STDEV`…); xoá field được tham chiếu → header cột và API schema báo `#REF`; lookup `sum` hiển thị theo `style` tiền tệ |
| S5 | Automation lõi, email, thông báo trong app, button field (theo BACKLOG S5 — "Quyết định S5", "Quyết định S5 email"; sửa ở T502): mô hình + API quản lý + `run_as` + take over (ADR-25); trigger `record.created|updated|deleted`, `record.matches` (chuyển không khớp → khớp), `form.submitted`, `schedule`, `record.date_reached`, `button.clicked`; condition có `changed*`, bước `if` một cấp; actions `create_record`/`update_record`/`update_records`/`find_records`/`delete_record`/`delay` + recheck, `send_email` (Markdown hẹp, danh tính gửi ADR-33, chữ ký, footer, đính kèm từ record trigger), `send_notification` (ADR-32), `send_telegram`; giá trị §11.4 + template `{{ }}` + `digest` (cấm `REGEX*`); event có `batch`/`via` + `skip_bulk` + breaker theo đơn vị kích hoạt + trần fan-out (ADR-26), nối `afterRecompute` → `record.updated`, loop guard, retry/idempotency/timeout/concurrency, run log + chạy lại + thời hạn lưu; SMTP cấp instance + "Kiểm tra kết nối"; hạ tầng thông báo ADR-29 §1 phần cần cho S5 (`meta.notifications`, trung tâm thông báo, tuỳ chọn, tắt tiếng theo base, tần suất email `immediate | daily | off`), `automation.disabled`/`automation.batch_overflow`; button field | Kịch bản §24 biến thể S5 chạy end-to-end (form → `update_record` → `record.matches` → `send_notification` + email → `delay` + recheck → `skipped`); P29, P31–P33, P37–P38 xanh; import 5.000 dòng không tắt automation `record.created` (một đơn vị breaker, tối đa 1.000 run + một run `batch_fanout_exceeded`), `skip_bulk` bỏ qua cả lô; lịch 08:00 gửi email/Telegram danh sách ticket quá hạn bằng `find_records` + `digest`; gỡ role của `run_as` → automation tắt, owner/admin base nhận thông báo realtime, take over bật lại |
| S5b | Phần còn lại của thông báo (ADR-29 §1, ADR-34; theo BACKLOG S5b — "Quyết định S5b"): `notify_on_assign` (`record.assigned`, ghi hàng loạt gom một thông báo mỗi người mỗi `batch.id`), theo dõi record (tự theo dõi khi tạo/được gán, thủ công; `record.followed_changed` gom theo record, không cho thay đổi hàng loạt), nhắc hạn field ngày qua **lõi quét thời gian dùng chung** tách khỏi automation (con trỏ theo field, quyền theo người nhận lúc gửi; `record.date_reached` dùng cùng lõi), `import.finished`, kênh Telegram cá nhân qua **bot của org** (liên kết deep link `/start <token>`); tồn S5: contract `display_name` của danh tính (QA M7), QA L1/L2/L6, quota email trước khi Valkey sẵn sàng, `SMTP_MAX_PER_SEC` theo giây trượt, tab lịch sử chạy trên điện thoại, nhân bản automation (chép ảnh thân thư); checklist kiểm email client thủ công. **Ngoài phạm vi S5b** (T542, BACKLOG S5b): nhắc hạn theo từng ô và nhiều nhắc trên một field (P2); điều kiện bỏ nhắc (dùng automation `record.date_reached` + `condition`); nhắc theo timezone người nhận (giữ timezone field/org); `record.followed_changed` cho xoá/khôi phục record, thay đổi hàng loạt và giá trị computed tính lại; trang "Record tôi theo dõi"; đồng bộ đã đọc giữa thiết bị bằng message realtime riêng (P1); bot Telegram cấp instance; webhook Telegram, Telegram trong nhóm/kênh cho thông báo cá nhân, nút hành động trong tin Telegram/email (Phase 2); mobile push (P2); digest `weekly`; tồn S5 L3, L4, L5, L7, L9–L12, L13, L15, S5-review §4 #17 (xét ở S9); gói webhook/HTTP (S5c); `comment.*` (S11); `approval.*` (S10) | Gán u_sales1 vào `owner` → u_sales1 thấy thông báo realtime < 1 s và nhận email theo tần suất đã chọn; sửa bằng dán 200 dòng → người theo dõi không nhận thông báo, người được gán nhận một thông báo gom; người mất quyền đọc record không nhận gì (kể cả qua email/Telegram; P39–P43 xanh); nhắc hạn bắn đúng một lần theo timezone field; tắt kênh nào thì không gửi qua kênh đó |
| S5c | Gói webhook/HTTP (ADR-22, ADR-27, ADR-35; theo BACKLOG S5c — "Quyết định S5c"): lõi mạng ra chống SSRF dùng chung (§14.3, `meta.http_allowlist` theo tên host, không follow redirect) + nhịp theo host đích và `Retry-After`; action `http_request` (gửi thử) / `run_n8n_workflow` qua **outbox hai pha**, secret `http_header`/`webhook_signing`; incoming webhook (Bearer, Standard Webhooks, rate limit từng hook, chống replay, "nghe request mẫu") + trigger `webhook.received` + tham chiếu `{ "trigger": body\|headers\|query }` (§11.4), token causation (ADR-27), Standard Webhooks ra (ADR-22); gom thông báo cho ghi từ webhook theo (hook, table); Telegram: chế độ webhook tuỳ chọn khi `PUBLIC_URL` https, poll thưa, trả lời qua bucket của bot (S5b-review §11 #1–#5). **Ngoài phạm vi S5c**: webhook ra độc lập kiểu Airtable Webhooks API (P1); chữ ký `v1a`, follow redirect, proxy egress, mTLS, OAuth2 cho `http_request`, response tuỳ biến từ webhook vào (P2); IP allowlist cho webhook vào (P1); URL test riêng kiểu n8n; webhook Telegram cho bot chỉ dùng `send_telegram`; outbox hai pha cho email/Telegram (S9); S5b-review §11 #6–#12 (S9); `comment.*` (S11); `approval.*` (S10) | A → `http_request` vào hook của B → B sửa record kích hoạt A dừng ở giới hạn depth; n8n nhận payload ký đúng Standard Webhooks; hook vượt rate limit → `429`; `http_request` tới IP nội bộ ngoài allowlist bị chặn (kể cả DNS rebinding, redirect); worker dừng giữa hai pha → đích nhận một lần theo `webhook-id`; ghi từ webhook gán người hàng trăm lần → một thông báo gom; P44–P52 xanh |
| S6 | Hoàn thiện phân quyền (ADR-36; theo BACKLOG S6 — "Quyết định S6"): UI cấu hình role (table/field/record rule đã có từ S1; thêm field link trong record rule) + gán thành viên/nhóm + quyền hiệu lực của một thành viên; API token + scope (giao quyền user ∩ scope ∩ base, mọi route khai báo scope, nguồn token trong lịch sử/audit); WS bằng token; OIDC generic cấp instance (PKCE, liên kết tài khoản an toàn, JIT có điều kiện); audit log viewer org + base; phủ quyền cho WS/export/share link; kéo từ S5c: secret HTTP gắn host được phép, cứu dòng giao HTTP + `forceUnlockWorkers`, điều tra N14/t314 + tách app shell. **Ngoài phạm vi S6**: dashboard và P21 (S7); map group → role, bắt buộc SSO, RP-initiated logout, SAML, SCIM, IdP theo org (P1/P2); service account, ứng dụng OAuth bên thứ ba, xem trước toàn app như người khác (P2); field phụ câu hỏi link qua form link `org` (P2); S5c-review §12 còn lại (S9) | Ma trận C§5 **P01–P20, P22–P64** xanh qua HTTP (P21 ở S7); user bị giới hạn không thấy field/record qua API (session và token), WS (cookie và token), export, share link; token thu hồi mất hiệu lực ngay, WS đóng ≤ 1 s; đăng nhập OIDC không chiếm được tài khoản qua email chưa xác minh; admin cấu hình role bằng UI; audit viewer lọc p95 < 300 ms trên 1 triệu dòng; secret HTTP không gửi tới host ngoài danh sách |
| S7 | Dashboard và chia sẻ (ADR-38; theo BACKLOG S7 — "Quyết định S7"): kéo từ S6 trước — E2E song song (org seed riêng mỗi worker), job CI `perf` hằng đêm trên `ubuntu-latest` (không chặn PR), đặt lại mật khẩu thu hồi API token (M3), đua phím ô lưới (L15), preset token "Automation" có `records:read`, đuôi gói base `.chbase` (ADR-37); dashboard tuỳ biến §10 (kpi, bar nhóm/chồng/chồng 100 %, line/vùng, combo hai trục, pie/donut, table, text, filter control; theme, click-through, TV mode, xuất PNG/CSV theo `download`), bấm chart để lọc các chart cùng nguồn, slicer khoảng số + nối tầng trong cùng table + giá trị mặc định, quyền `dashboards.<id>` + P21 ("thống kê theo quyền người xem"), cache §10.4 theo dấu vân tay quyền, kênh `dashboard:{id}`; share link dashboard (quyền người tạo, polling) + nhúng (chỉ link public không mật khẩu, `frame-ancestors` theo link) cho mọi target; export qua share link view (`allow_export`); grid: tô màu dòng/ô theo điều kiện (`view.config.color_rules`, đánh giá ở server theo quyền). Dòng tổng dưới cột đã có ở S4b (T472). **Ngoài phạm vi S7**: widget Phase 2 §10.2, click-through và realtime WS qua share link, nối tầng khác table, chế độ "thống kê toàn bộ dữ liệu", xuất PDF/lịch gửi dashboard (P2); Animate UI/`motion` (không dùng); tồn QA S6 còn lại (S9) | Dashboard 5 widget trên 200.000 record lần đầu < 2 s (job CI `perf`); P21 + P65–P77 xanh; u_sales1 không thấy tổng `cost` (widget "Không có quyền") qua session, token, WS, share link; link public không lộ field ngoài phạm vi, nhúng chỉ ở origin được phép; bấm cột "Khẩn" lọc mọi widget cùng nguồn; slicer tỉnh → quận nối tầng; màu dòng tôn trọng record/field rule; export qua link không có cột ẩn; đặt lại mật khẩu thu hồi token |
| S8 | AI: cấu hình provider, AI formula, AI automation builder, AI Q&A trả số/bảng/biểu đồ, ai_classify/ai_fill_field, action `ai_generate_text` (output dùng cho bước sau), kiểu field AI (sinh theo dòng, tự cập nhật khi field nguồn đổi, xem trước 5 dòng, quota token theo org) | Câu "khi ticket chuyển DONE thì gửi Telegram cho người phụ trách" sinh đúng automation (chưa bật); Q&A "doanh thu theo tháng" trả biểu đồ đúng quyền người hỏi; field AI tóm tắt chỉ chạy khi `allow_record_data` bật và dừng khi hết quota |
| S9 | Xuất/nhập nguyên base (§17.1, ADR-24); hardening: bench §21, security review §14, đo tài nguyên profile minimal, test nâng cấp N-1→N, tài liệu self-host en/vi, image multi-arch ký cosign + SBOM, release v0.1.0 công khai | Checklist §23 đạt, người ngoài cài được chỉ bằng README |
| S10 | **v0.2** · Phê duyệt trong base (ADR-29 §2): flow nhiều bước (`when` theo Filter DSL), người duyệt theo user/group/field user/người gửi, any/all, trả lại, rút, CC, khoá record `409 RECORD_LOCKED` (trừ `editable_fields` của bước), hộp "Chờ tôi duyệt", nhắc SLA, action `start_approval`, trigger `approval.completed`, mục phê duyệt trong tab Lịch sử | Đơn > 50 triệu đi qua bước giám đốc, ≤ 50 triệu bỏ qua; khi đang duyệt mọi PATCH/DELETE/import upsert vào record trả `409 RECORD_LOCKED`, người duyệt vẫn sửa được field cho phép; mode `all` cần đủ người; trả lại tạo task mới ở bước trước; automation `approval.completed` gửi Telegram cho người gửi; người không đọc được record nhận `404` với task/instance |
| S11 | **v0.2** · Bình luận record (ADR-29 §3): thread một cấp, @mention, reaction, resolve/mở lại, sửa/xoá của mình, admin xoá mọi comment, realtime `comment.changed`, thông báo `comment.mentioned`/`comment.replied`, `comments.jsonl` trong gói `.chbase` | Reader bình luận được (quyền theo đọc), u_sales1 không thấy comment của r2 (`404`); @mention người không đọc được record → không có thông báo; comment hiện realtime ở tab khác < 1 s; xoá mềm record rồi khôi phục giữ nguyên comment |

---

## 23. Tiêu chí nghiệm thu MVP

User có thể:
1. Đăng nhập (password hoặc OIDC), được mời vào org/workspace.
2. Tạo workspace, base, nhiều table, field các kiểu MVP, gồm attachment; link một/hai chiều; bảng con nhúng; sub-records dạng cây; lookup theo điều kiện (không cần link); formula tham chiếu cùng dòng, qua link và cross-table (`FILTER`/`CurrentValue`) với cú pháp tương thích Lark.
3. Thêm/sửa/xoá (thùng rác, khôi phục) record; copy/paste nhiều ô.
4. Import CSV/XLSX, export theo view.
5. Tạo Grid/Kanban/Form view; filter/sort/group; tìm không dấu.
6. Tạo nhiều dashboard tuỳ biến (layout, theme, màu, định dạng, filter control, so sánh kỳ trước) với KPI/bar/line/pie/table/text.
6a. Tạo link chia sẻ (org hoặc public, mật khẩu, hết hạn, embed) cho view, form, dashboard; thu hồi được; người xem qua link không thấy gì ngoài phạm vi.
7. Tạo automation trigger từ update record với `changed_to`, gọi HTTP/n8n/Telegram/email, xem log, chạy lại run lỗi; automation không tự lặp vô hạn.
8. Gán role, giới hạn truy cập table/field/record; giới hạn có hiệu lực ở API, WS, export, dashboard, AI.
9. Dùng API token có scope.
10. Nhận cập nhật realtime.
10a. Nhận thông báo trong app (và email/Telegram nếu bật) khi được gán vào record, record đang theo dõi thay đổi, đến hạn field ngày, automation của mình bị tắt; tắt được theo loại và kênh (S5b).
11. Dùng AI với dữ liệu tôn trọng phân quyền và cài đặt `allow_record_data`; tắt AI hoàn toàn mà không mất chức năng khác.
12. Xuất toàn bộ một base (schema + dữ liệu + file) thành một gói và nhập lại vào instance khác.
13. Một người lạ cài được từ README trong < 15 phút bằng profile minimal.

---

## 24. Kịch bản end-to-end chuẩn (dùng làm test E2E Playwright)

```text
Ticket tạo từ form public
  → automation A (record.created): ai_classify → field "Mức độ"
  → automation B (record.updated, watch Mức độ, changed_to=Khẩn): send_telegram
  → automation C (record.created): delay 4h, recheck "Trạng thái is_not DONE" → send_telegram "Quá SLA"
  → user đổi Trạng thái → DONE trước 4h → run C kết thúc status=skipped
  → dashboard đếm ticket theo trạng thái cập nhật
```
(Trong CI thay AI bằng mock provider và delay bằng 5s.)

---

## 25. Quy tắc bắt buộc cho AI coding agent

Agent MUST:
- Đọc tài liệu này và code liên quan trước khi sửa; không tạo service/module trùng chức năng.
- Mỗi task nhỏ, một mục đích; không refactor ngoài phạm vi.
- Migration meta versioned, không sửa migration đã merge.
- Mọi DDL bảng `data.*` chỉ qua `SchemaService`; mọi đọc/ghi record chỉ qua `RecordQueryService`/`RecordMutationService`.
- Không bao giờ nối chuỗi SQL từ input; không dùng tên người dùng đặt làm identifier.
- Không `eval`/`new Function`/`vm` ở bất kỳ đâu.
- Kiểm tra quyền ở server cho mọi endpoint, WS subscription, export, dashboard, AI, share link.
- Ghi audit cho mutation nhạy cảm (§14.2).
- Idempotency cho mọi side effect bên ngoài.
- Schema/data mutation trong transaction; publish realtime và enqueue ngoài chỉ sau commit (enqueue graphile-worker thì trong transaction).
- Test bắt buộc: test tương đương TS/SQL cho filter-dsl và formula-engine; unit cho package thuần (filter-dsl, formula-engine, permissions, field-types conversion), integration với Postgres thật (Testcontainers) cho query/mutation/permission, E2E cho luồng §24. Coverage package thuần ≥ 90%.
- Không đổi API contract âm thầm; cập nhật zod + `CONTRACTS.md` + OpenAPI cùng PR.
- Không thêm dependency mới khi chưa ghi lý do; không thêm dịch vụ hạ tầng mới (Kafka, Elastic, ClickHouse…).
- Ghi ADR cho mọi sai khác kiến trúc so với tài liệu này.
- Không tạo feature gate, license check, cờ enterprise, telemetry mặc định, hay phụ thuộc dịch vụ bên ngoài bắt buộc (§1A).
- Chỉ thêm dependency có license tương thích AGPL-3.0.
- Code, comment, commit, tên API bằng tiếng Anh; chuỗi UI qua i18n (có đủ `en` và `vi`).
- Mọi commit có `Signed-off-by` (DCO).

Mỗi task trả về:
```text
1. Đã thay đổi gì
2. File thay đổi
3. Database migration
4. Thay đổi API / contract
5. Test (đã thêm/chạy, kết quả)
6. Ảnh hưởng bảo mật / quyền
7. Ảnh hưởng triển khai
8. TODO còn lại
9. Câu hỏi mở (nếu có)
```

## 26. Definition of Done

Theo **từng task**: DoD trong `AGENTS.md` (task chỉ backend không cần UI và ngược lại). DoD của cả tính năng (khi mọi task liên quan xong): frontend + backend xong; kiểm tra quyền; validate; migration; test pass trong CI; audit đã xét; realtime đã xét; xử lý lỗi (problem+json, UI dịch theo `code`, đủ `en` và `vi`); OpenAPI cập nhật; chạy được trên `docker compose up` sạch.

## 27. Tham chiếu

- Lark Base: https://www.larksuite.com/product/base — tham chiếu capability, không sao chép.
- Mô hình field/formula/lookup/link/role/filter của Lark Base (tài liệu chính thức trong repo `larksuite/cli`, thư mục `skills/lark-base/references/`: `lark-base-field-schema.md`, `lark-base-field-update.md` (whitelist đổi kiểu), `lark-base-field-formula.md`, `lark-base-field-lookup.md`, `lark-base-role-config.md`, `lark-base-filter-condition.md`, `lark-base-view.md`)
- Airtable Web API (typecast, upsert, mã lỗi 422), Teable API (`fieldKeyType`, `cellFormat`) — tham chiếu hành vi và cú pháp, không sao chép code.
- Sản phẩm mã nguồn mở cùng hướng (tham khảo thiết kế, **không copy code** để giữ kiến trúc sạch và lịch sử bản quyền rõ ràng): Teable (AGPL, Postgres-native, bảng thật; một số tính năng ở bản Enterprise), Baserow (MIT core, một số tính năng ở premium), NocoDB (đã chuyển sang Sustainable Use License), Grist (Apache-2.0).
- Phase 2 gợi ý cho cộng đồng: "Xem thử bằng vai trò" cho admin (chỉ đọc, không mạo danh ghi, có audit), import từ Airtable/Lark Base qua API của họ, plugin system, SAML/LDAP, Helm chart, Calendar/Gallery/Gantt, link khác base. (Phê duyệt và comment đã có lộ trình S10/S11, ADR-29.)
