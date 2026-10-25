# ADR-0016: Object storage — Garage thay MinIO

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §3, §16, §19, §20; AGENTS.md (Môi trường); BACKLOG T003, T005

## Bối cảnh

SPEC v1.1 chọn MinIO làm object storage mặc định trong Docker Compose. Tình trạng MinIO community edition:

- 05/2025: gỡ admin console khỏi bản community.
- 10/2025: ngừng publish Docker image lên Docker Hub/Quay.
- 12/2025: repo chuyển sang "maintenance mode".
- 02/2026: repo được đánh dấu "no longer maintained" và archive; image `minio/minio` không còn pull được.

Hệ quả: `docker compose up` sạch (một phần của Definition of Done) sẽ fail. Dù có pin image cũ thì cũng không còn bản vá bảo mật. Việc này mâu thuẫn với cam kết "nâng cấp an toàn cho người lạ tự host" (SPEC §1A).

## Quyết định

1. Profile `full` dùng **Garage** (Rust, AGPL-3.0, image multi-arch amd64/arm64, RAM ~50 MB) làm object storage mặc định, qua S3 API.
2. Profile `minimal` dùng `STORAGE_DRIVER=local` (volume); API tự phát URL upload/tải ký HMAC ngắn hạn thay cho presigned S3. Hai driver chung một interface `StorageDriver` trong `server-core`.
3. Code chỉ dùng tập S3 API mà Garage hỗ trợ: PUT/GET/HEAD/DELETE object, multipart upload, presigned URL (PUT/GET), CORS theo bucket. **Không** dùng versioning, object lock, lifecycle, presigned POST policy.
4. Compose có one-shot service `storage-init` chạy trước `api`: `garage layout assign` cho node đơn, apply layout, tạo bucket `cellhive`, access key, cấu hình CORS theo `PUBLIC_URL`. Script idempotent (chạy lại không lỗi).
5. Vẫn hỗ trợ mọi S3-compatible khác qua env (AWS S3, Cloudflare R2, SeaweedFS, MinIO bản thương mại).

## Phương án đã cân nhắc

| Phương án | Ưu | Nhược | Kết luận |
|---|---|---|---|
| Garage | AGPL (tương thích), nhẹ, multi-arch, có presigned + CORS + multipart | Cần bước khởi tạo layout; ít tính năng S3 nâng cao | **Chọn** |
| SeaweedFS | Apache-2.0, nhiều tính năng | Nhiều thành phần (master/volume/filer/s3), nặng hơn cho máy 2 GB | Hỗ trợ qua env, không làm mặc định |
| RustFS | Apache-2.0, API giống MinIO | Còn non trẻ | Theo dõi, xem lại ở Phase 2 |
| Pin image MinIO cũ | Không đổi code | Không còn bản vá CVE, image có thể biến mất | Loại |
| Chỉ local volume | Đơn giản nhất | Không scale nhiều instance api | Chỉ dùng cho `minimal` |

## Hệ quả

- `/readyz` kiểm tra "storage" (Garage hoặc thư mục local ghi được) thay cho "MinIO".
- Backup: tài liệu self-host hướng dẫn `rclone sync` cho bucket, hoặc backup volume ở `minimal`.
- Test tích hợp (Testcontainers) chạy Garage thật cho luồng upload/download ở S4.
- Người dùng muốn chuyển từ `minimal` sang `full` cần lệnh `cellhive storage migrate --from local --to s3` (TODO S4).
