# ADR-0019: PostgreSQL 18 là phiên bản hỗ trợ duy nhất trong MVP

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC §3, §5.2, §20; AGENTS.md; BACKLOG T003

## Bối cảnh

Tài liệu v1.1 mâu thuẫn: SPEC ghi `postgres:16` / "16+", còn AGENTS.md và BACKLOG T003 ghi PostgreSQL 17. PostgreSQL 18 phát hành 09/2025 và đến 09/2026 đã có nhiều bản vá. Hỗ trợ nhiều major version sẽ nhân đôi ma trận CI mà không đem lại lợi ích cho dự án mới (chưa có người dùng cũ).

Tính năng PG 18 có ích trực tiếp:
- `LIKE` trên nondeterministic collation, mở đường cho tìm kiếm không phân biệt hoa thường/dấu bằng collation ICU trong tương lai.
- `uuidv7()`.
- Asynchronous I/O cải thiện quét tuần tự (dashboard aggregate, backfill).
- Virtual generated columns: **không** dùng cho computed field vì không tham chiếu bảng khác được. Chỉ ghi nhận để khỏi bị đề xuất lại.

## Quyết định

1. MVP chỉ hỗ trợ **PostgreSQL 18.x** (image `postgres:18`); CI chạy một phiên bản.
2. Compose mount volume tại **`/var/lib/postgresql`**. Image 18+ đổi `PGDATA` thành `/var/lib/postgresql/18/docker`; mount kiểu cũ `/var/lib/postgresql/data` làm container không khởi động.
3. App kiểm tra `server_version_num >= 180000` lúc khởi động; thấp hơn → thoát với thông báo rõ.
4. Lên major version sau (19+) = ADR mới + tài liệu `pg_upgrade --link` trong `docs/*/self-hosting.md`.

## Hệ quả

- Người dùng Postgres được quản lý (RDS, Cloud SQL…) cần bản 18; ghi vào README.
- Extensions yêu cầu giữ nguyên (`pgcrypto`, `pg_trgm`, `unaccent`, `citext`), đều có trong image chính thức.
