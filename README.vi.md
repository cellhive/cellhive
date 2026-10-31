# Cellhive

> Read this in [English](README.md).

Cellhive là nền tảng cơ sở dữ liệu no-code tự host, theo tinh thần Airtable và Lark Base: bảng với nhiều kiểu trường, nhiều view, dashboard, tự động hoá, REST API, phân quyền chi tiết và AI tuỳ chọn.

Dự án **mã nguồn mở hoàn toàn**. Không có bản Enterprise, không license key, không khoá tính năng. SSO, phân quyền theo trường và bản ghi, nhật ký hoạt động, tự động hoá và AI đều nằm trong bản chính.

> **Trạng thái:** đang phát triển, chưa dùng được. Thiết kế nằm trong [`docs/`](docs/).

## Nguyên tắc

- **Dữ liệu là của bạn.** Mỗi bảng là một bảng PostgreSQL thật, công cụ BI đọc trực tiếp được, và xuất được nguyên một base bất cứ lúc nào.
- **Dễ tự host.** Một lệnh `docker compose up`, chạy được trên máy 2 GB cho nhóm nhỏ, có image amd64 và arm64.
- **Chạy được offline.** Không bắt buộc dịch vụ bên ngoài, không gửi telemetry mặc định. AI là tuỳ chọn và chạy được bằng model local.
- **Phát triển công khai.** AGPL-3.0, đóng góp theo [DCO](https://developercertificate.org/), không CLA.

## Tài liệu

| Tài liệu                                   | Nội dung                                             |
| ------------------------------------------ | ---------------------------------------------------- |
| [`docs/SPEC.md`](docs/SPEC.md)             | Kiến trúc, mô hình dữ liệu, ngữ nghĩa tính năng      |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md)   | Định dạng API, bản ghi, bộ lọc, lỗi, realtime, event |
| [`docs/FRONTEND.md`](docs/FRONTEND.md)     | Kiến trúc frontend                                   |
| [`docs/integrations/`](docs/integrations/) | Hướng dẫn cho người dùng và tích hợp                 |
| [`docs/adr/`](docs/adr/)                   | Các quyết định kiến trúc                             |
| [`AGENTS.md`](AGENTS.md)                   | Quy tắc làm việc cho người đóng góp và coding agent  |

## Phát triển

Từ lúc clone đến khi đăng nhập được bằng user demo mất khoảng mười phút (phần lớn là lần `pnpm install` đầu tiên và tải image).

### Chuẩn bị

- **Node.js 24**: phiên bản ghi trong [`.nvmrc`](.nvmrc), nên `nvm use`, `fnm use` hoặc `volta` tự chọn đúng.
- **pnpm**: chạy `corepack enable` một lần; Corepack sẽ cung cấp đúng phiên bản pnpm ghi trong `package.json`.
- **Docker** kèm Docker Compose v2, đang chạy (Docker Desktop, OrbStack, Colima hoặc Docker Engine).
- Các cổng local còn trống: 3000 (API), 5173 (web), 5432 (PostgreSQL), 6379 (Valkey), 3900 và 3903 (Garage).

### Các bước

```bash
# 1. Cấu hình: giá trị mặc định cho dev, mọi secret đều là giá trị công khai chỉ dùng cho dev
cp .env.example .env

# 2. Cài dependency
pnpm install

# 3. PostgreSQL 18, Valkey và Garage (S3) trong Docker, chỉ bind 127.0.0.1
pnpm dev:infra

# 4. Tạo schema database
pnpm db:migrate

# 5. Tổ chức demo "Cellhive Demo": sáu user, base "Chăm sóc khách hàng" gồm Customers,
#    Tickets, Orders (7.200 bản ghi) và role Sales; in bảng tóm tắt
pnpm seed:demo

# 6. API (+ worker chạy nền) và các app khác, tự reload khi sửa code
pnpm dev
```

- API chạy ở <http://localhost:3000> (`/healthz`, `/api/v1/...`). Web app chạy ở <http://localhost:5173> khi đã có `apps/web`.
- Đăng nhập bằng một user demo, ví dụ `admin@demo.cellhive.local` / `Cellhive-demo-2026`. Các user còn lại là `editor@`, `reader@`, `sales1@`, `sales2@` và `out@demo.cellhive.local`, cùng mật khẩu; `pnpm seed:demo` in ra quyền của từng người. Mật khẩu này chỉ dùng khi phát triển local: seed từ chối chạy khi `NODE_ENV=production` nếu không có `--force`, và khi đó mỗi user nhận một mật khẩu ngẫu nhiên.
- Chưa có web app thì kiểm tra API bằng curl:

  ```bash
  curl -si -c /tmp/ob.jar -H 'content-type: application/json' \
    -d '{"email":"admin@demo.cellhive.local","password":"Cellhive-demo-2026"}' \
    http://localhost:3000/api/v1/auth/login          # 204 + cookie phiên
  curl -s -b /tmp/ob.jar http://localhost:3000/api/v1/me
  ```

- Dừng và xoá hạ tầng local **cùng toàn bộ dữ liệu** bằng `pnpm dev:infra:down`.

Trước khi mở pull request, commit rồi chạy `pnpm verify:push` (xem [CONTRIBUTING.md](CONTRIBUTING.md)).

### Xử lý sự cố

| Triệu chứng                                                       | Cách xử lý                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon` / `pnpm dev:infra` lỗi ngay | Bật Docker (Desktop, OrbStack, Colima…) và kiểm tra `docker info`.                                                                                                                                                                                                                                                                                                                                   |
| `port is already allocated` / `address already in use`            | Có PostgreSQL, Redis/Valkey hoặc app khác đang dùng cổng: `lsof -i :5432` (hoặc `:6379`, `:3000`, `:3900`) cho biết tiến trình nào; tắt nó đi. Riêng API có thể đổi `PORT` trong `.env`.                                                                                                                                                                                                             |
| Hai checkout hoặc worktree cần hạ tầng riêng                      | Đặt cho mỗi bản một project Compose và cổng host riêng trong `.env` của nó (xem mục `docker-compose.dev.yml only` trong `.env.example`): `COMPOSE_PROJECT_NAME`, `DEV_POSTGRES_PORT`, `DEV_VALKEY_PORT`, `DEV_GARAGE_S3_PORT`, `DEV_GARAGE_ADMIN_PORT`, rồi trỏ `DATABASE_URL`, `CACHE_URL`, `S3_ENDPOINT` tới các cổng đó. Khi đó `pnpm dev:infra:down` chỉ xoá container và volume của project đó. |
| `Invalid environment configuration` kèm danh sách biến            | Thiếu `.env` hoặc `.env` đã cũ: so sánh với `.env.example`.                                                                                                                                                                                                                                                                                                                                          |
| `NODE_ENV is production … refusing to create demo users`          | Thiếu `.env` (`NODE_ENV` mặc định là `production`): `cp .env.example .env`.                                                                                                                                                                                                                                                                                                                          |
| `The database is not migrated`                                    | Chạy `pnpm db:migrate`.                                                                                                                                                                                                                                                                                                                                                                              |
| `Demo data already exists; nothing to do.`                        | Bình thường khi chạy lần hai: không tạo trùng, chỉ in lại bảng tóm tắt.                                                                                                                                                                                                                                                                                                                              |
| `Some demo data exists but not all of it`                         | Lần seed trước bị ngắt giữa chừng. Làm sạch dữ liệu (dòng cuối).                                                                                                                                                                                                                                                                                                                                     |
| Đăng nhập trả `401`                                               | Kiểm tra email và mật khẩu trong bảng tóm tắt của seed; sai 10 lần trong 15 phút thì email bị khoá 15 phút (`423 ACCOUNT_LOCKED`): chờ, hoặc làm sạch dữ liệu.                                                                                                                                                                                                                                       |
| Làm lại từ dữ liệu trống                                          | `pnpm dev:infra:down && pnpm dev:infra && pnpm db:migrate && pnpm seed:demo` (`dev:infra:down` xoá volume Docker).                                                                                                                                                                                                                                                                                   |

## Giấy phép

- Dự án dùng [GNU Affero General Public License v3.0 only](LICENSE).
- `packages/contracts` (schema API) dùng [Apache License 2.0](packages/contracts/LICENSE) để client và tích hợp không bị ràng buộc bởi AGPL.
