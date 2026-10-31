# Architecture Decision Records

ADR-01 → ADR-15 là các quyết định gốc, được tóm tắt trong `SPEC.md` §2 (không có file riêng). Từ ADR-16 trở đi, mỗi quyết định có một file trong thư mục này.

Thứ tự ưu tiên (AGENTS.md): ADR mới nhất > CONTRACTS (định dạng) / SPEC (kiến trúc) > FRONTEND > code hiện có.

Dòng "Nguồn:" nhắc `docs/reviews/…` hoặc BACKLOG trỏ tới ghi chú lập kế hoạch của nhóm bảo trì (repo riêng, không công khai); nội dung đã chốt nằm trong chính ADR.

| # | Tiêu đề | Trạng thái | Ngày |
|---|---|---|---|
| [0016](0016-object-storage-garage.md) | Object storage: Garage thay MinIO | Accepted | 2026-09-23 |
| [0017](0017-valkey-instead-of-redis.md) | Valkey thay Redis | Accepted | 2026-09-23 |
| [0018](0018-job-queue-concurrency.md) | Hàng đợi job: không dùng named queue theo org | Accepted | 2026-09-23 |
| [0019](0019-postgresql-18.md) | PostgreSQL 18 là phiên bản hỗ trợ duy nhất | Accepted | 2026-09-23 |
| [0020](0020-column-budget-and-compaction.md) | Ngân sách cột vật lý và compaction bảng dữ liệu | Accepted | 2026-09-23 |
| [0021](0021-formula-explicit-timezone.md) | Hàm formula nhận timezone tường minh | Accepted | 2026-09-23 |
| [0022](0022-standard-webhooks.md) | Ký webhook theo Standard Webhooks | Accepted | 2026-09-23 |
| [0023](0023-audit-and-record-history.md) | Audit log và lịch sử record | Accepted | 2026-09-23 |
| [0024](0024-base-export-import-package.md) | Gói xuất/nhập nguyên một base | Accepted | 2026-09-23 |
| [0025](0025-automation-run-as.md) | Automation chạy bằng quyền người bật/sửa cuối (`run_as`) | Accepted | 2026-09-24 |
| [0026](0026-bulk-writes-and-automation.md) | Ghi hàng loạt và automation: lô, breaker theo lô, `skip_bulk` | Accepted | 2026-09-24 |
| [0027](0027-http-request-causation-token.md) | Chống vòng lặp `http_request` gọi lại webhook của chính instance | Accepted | 2026-09-24 |
| [0028](0028-link-direction-conversion.md) | Đổi link một chiều ↔ hai chiều; tối đa 500 liên kết mỗi ô | Accepted | 2026-09-24 |
| [0029](0029-notifications-approval-comments.md) | Thông báo, phê duyệt và bình luận trên record | Accepted | 2026-09-24 |
| [0030](0030-form-anti-spam.md) | Chống spam form không dùng dịch vụ ngoài: submit token ký, honeypot, rate limit | Accepted | 2026-09-24 |
| [0031](0031-realtime-view-scoped-subscription.md) | Subscription `table:` theo view đang mở: server đánh giá filter view (kể cả điều kiện ẩn), client kiểm filter tạm/search qua `ids` | Accepted | 2026-09-25 |
| [0032](0032-automation-notifications-buttons-email-templates.md) | Thông báo từ automation, quyền của button field, quy tắc template email | Accepted | 2026-10-05 |
| [0033](0033-email-sender-identities.md) | Danh tính gửi email, chữ ký và chính sách footer | Accepted | 2026-10-05 |
| [0034](0034-shared-time-scan-and-s5b-notifications.md) | Lõi quét thời gian dùng chung, gom thông báo gán/theo dõi, kênh Telegram cá nhân qua bot của org | Accepted | 2026-10-17 |
| [0035](0035-webhooks-http-outbox-ssrf.md) | Webhook vào, HTTP ra qua outbox hai pha, lõi chống SSRF, gom thông báo theo nguồn webhook, chế độ webhook Telegram | Accepted | 2026-10-17 |
| [0036](0036-api-tokens-oidc-secret-hosts.md) | API token cá nhân có scope (HTTP + WS), OIDC generic cấp instance, secret HTTP gắn host được phép, cứu dòng giao HTTP | Accepted | 2026-10-19 |
| [0037](0037-rename-to-cellhive.md) | Đổi tên OpenBase thành Cellhive; định danh nội bộ trung lập thương hiệu; sửa migration tại chỗ một lần | Accepted | 2026-10-24 |
| [0038](0038-dashboards-widget-query-share-embed.md) | Dashboard: layout trên widget, truy vấn widget một cửa theo quyền người xem, cache theo dấu vân tay quyền, chia sẻ và nhúng | Accepted | 2026-10-25 |
| [0039](0039-ai-provider-structured-output.md) | AI: một cửa Chat Completions, thang đầu ra có cấu trúc, đầu ra theo tên, dữ liệu tối thiểu, field AI chạy nền | Proposed | 2026-10-31 |

## Mẫu

```markdown
# ADR-NNNN: <tiêu đề>

- Trạng thái: Proposed | Accepted | Superseded by ADR-XXXX
- Ngày: YYYY-MM-DD
- Thay thế / sửa: <mục SPEC/CONTRACTS bị ảnh hưởng>

## Bối cảnh
## Quyết định
## Phương án đã cân nhắc
## Hệ quả
```
