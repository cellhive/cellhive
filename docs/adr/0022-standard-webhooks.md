# ADR-0022: Ký webhook theo Standard Webhooks

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §11.7, §13.2, §13.3; CONTRACTS §10 (mới)

## Bối cảnh

SPEC v1.1 tự định nghĩa header `X-Signature = HMAC(secret, timestamp + "." + body)`, `X-Timestamp`, `X-Event-Id`. Cách làm đúng về bảo mật nhưng là định dạng riêng: mỗi người tích hợp (n8n, dịch vụ nội bộ) phải tự viết code verify.

[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) là spec mở cho đúng bài toán này (header `webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 trên `id.timestamp.body`), đã được nhiều nhà cung cấp lớn áp dụng. Có thư viện verify chính thức cho JS/TS, Python, Go, Java, Rust, Ruby, C#… (license MIT).

## Quyết định

1. Webhook ra (`http_request` có secret, `run_n8n_workflow`) và webhook vào (`/api/v1/hooks/:token` có secret) dùng Standard Webhooks v1. Định dạng chi tiết ở CONTRACTS §10.
2. `webhook-id` của webhook ra = `evt_…` của event gốc, giữ nguyên qua các lần retry, nên bên nhận dedupe được. `Idempotency-Key` vẫn gửi kèm (định danh theo action).
3. Chữ ký dùng phần secret sau prefix `whsec_`; hỗ trợ nhiều chữ ký trong một header để xoay secret không downtime (24h chồng lấp).
4. Server dùng package `standardwebhooks` (MIT) hoặc cài đặt tương đương kèm test vector từ spec. So sánh constant-time.

## Hệ quả

- Không còn header `X-Signature`, `X-Timestamp`, `X-Event-Id`. Chưa có code nên không phải migration.
- Tài liệu tích hợp chỉ cần trỏ tới thư viện chuẩn thay vì mô tả thuật toán riêng.
