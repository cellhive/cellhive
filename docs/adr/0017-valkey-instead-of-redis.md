# ADR-0017: Valkey thay Redis

- Trạng thái: Accepted
- Ngày: 2026-09-23
- Sửa: SPEC ADR-07, §3, §10.4, §15, §19, §20; AGENTS.md; BACKLOG T003, T005, T007; CONTRACTS §6

## Bối cảnh

SPEC v1.1 ghi "Redis 7". Từ 03/2024, Redis 7.4.x trở đi phát hành theo RSALv2/SSPLv1, không phải license OSI. Redis 8 có thêm lựa chọn AGPLv3, nhưng Redis Ltd. đã đổi license hai lần trong hai năm. Với một dự án có cam kết "mở vĩnh viễn" (SPEC §1A), dependency hạ tầng mặc định cũng nên là open source có governance trung lập.

Valkey là fork của Redis 7.2.4 do Linux Foundation quản lý, license BSD-3-Clause, tương thích giao thức và lệnh.

## Quyết định

1. Dùng **Valkey 8** (`valkey/valkey:8`) cho cả hai profile `minimal` và `full`. Vai trò giữ nguyên như ADR-07: pub/sub realtime, cache dashboard, rate limit. Không lưu dữ liệu cần bền vững.
2. Client Node: `ioredis` (MIT), vốn tương thích Valkey. Không dùng lệnh/module chỉ Redis mới có (RedisJSON, RediSearch, Redis 8 data types mới).
3. Env giữ tên trung lập: `CACHE_URL` (chấp nhận `redis://` / `rediss://`). Người tự host có thể trỏ tới Redis nếu muốn; CI chỉ test với Valkey.
4. Tài liệu và log gọi dịch vụ là "Valkey"; tên biến môi trường và code dùng thuật ngữ trung lập (`CACHE_URL`, module `cache`/`pubsub`) để trỏ được sang Redis nếu người tự host muốn.

## Phương án đã cân nhắc

| Phương án | Kết luận |
|---|---|
| Valkey 8 (BSD-3) | **Chọn**: open source, governance trung lập, tương thích |
| Redis 8 (AGPLv3 tuỳ chọn) | License ổn nhưng rủi ro đổi license lần nữa; vẫn chạy được qua `CACHE_URL` |
| Redis 7.2 (BSD) | Hết hạn hỗ trợ, không có bản vá mới |
| Bỏ hẳn cache server: `LISTEN/NOTIFY` + rate limit trong Postgres | Bớt một container cho `minimal`. Nhưng phải duy trì hai cách cài (NOTIFY có giới hạn payload 8 KB, gây tranh chấp khoá khi commit dưới tải cao). Để sau MVP; mở lại nếu đo ở S9 cho thấy `minimal` vượt 2 GB RAM |

## Hệ quả

- Chỉ đổi tên và image; mọi thiết kế ở SPEC §10.4, §15 giữ nguyên.
- `/readyz` kiểm tra Valkey; lỗi → `503 DEPENDENCY_UNAVAILABLE`.
