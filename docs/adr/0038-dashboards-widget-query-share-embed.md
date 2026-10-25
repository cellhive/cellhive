# ADR-0038: Dashboard — mô hình dữ liệu, truy vấn widget một cửa, cache theo quyền, chia sẻ và nhúng

- Trạng thái: Accepted (viết ở BACKLOG T805, có hiệu lực khi T805 merge)
- Ngày: 2026-10-25
- Thay thế / sửa: SPEC §5.10 (`meta.dashboards` bỏ `layout jsonb`, thêm `description`, `version`, `created_by`, `deleted_by`; `meta.dashboard_widgets` thêm `title`, `layout`), SPEC §10 (layout trên widget, thùng rác, `version`), SPEC §13.1 (route dashboard/widget); CONTRACTS §28 (mới), §8, §6, §26.3. Nguồn: BACKLOG "Quyết định S7" #4–#7, #22, #24; `docs/reviews/S7-research.md` §2, §4.

## Bối cảnh

S7 làm dashboard (S§10): mỗi base nhiều dashboard, mỗi dashboard ≤ 30 widget trên một table mỗi widget, số liệu theo quyền **người xem** (record rule + field rule — P21), filter control, global filter, lọc chéo, chia sẻ qua link và nhúng. SPEC §5.10 chỉ phác `meta.dashboards(…, layout jsonb, …)` và `meta.dashboard_widgets(…, config jsonb)`; quyền `dashboards.<id>` của role custom và resolve đã có từ S1/S6 nhưng `BASE_SCHEMA_META` trả `dashboards: []`.

Ràng buộc: không đường SQL riêng ngoài `RecordQueryService` (quy tắc vàng #1); không lộ dữ liệu ngoài quyền qua bất kỳ đường nào (WS, cache, link, token); không dịch vụ hạ tầng mới (quy tắc vàng #7); 5 widget trên 200.000 record lần đầu < 2 s (S§21).

## Quyết định

### 1. Mô hình (T805)

- `meta.dashboards(id 'dsh', organization_id, base_id, name, icon, description, theme jsonb, global_filters jsonb, position, version, created_by, deleted_at, deleted_by, created_at, updated_at)` — FK ghép `(organization_id, base_id)` → `bases` `ON DELETE CASCADE`; tên duy nhất không phân biệt hoa thường trong base **ngoài thùng rác** (index unique một phần trên `lower(name)`); index `(organization_id, base_id, position) WHERE deleted_at IS NULL`.
- `meta.dashboard_widgets(id 'wgt', organization_id, dashboard_id, type, title, config jsonb, layout jsonb {x,y,w,h}, created_at, updated_at)` — FK ghép `(organization_id, dashboard_id)` → `dashboards` `ON DELETE CASCADE`.
- **Layout nằm trên widget**, không trên dashboard (Quyết định S7 #5): một nguồn, xoá widget không để rác, `PUT /dashboards/:id/layout` ghi một lần mọi vị trí. Lưới 12 cột; kiểm (trong lưới, không chồng nhau) rồi lưu bản compact dọc bằng hàm thuần dùng chung server + web (`packages/contracts/src/dashboard-layout.ts`).
- `version` tăng ở mọi thay đổi dashboard, layout hoặc widget; `If-Match`/`version` lệch → `409 VERSION_CONFLICT` (như automation, C§21). Không cột `updated_by` (`params.updated_by = null`).
- **Config widget** theo loại (`kpi`, `bar`, `line`, `pie`, `combo`, `table`, `text`, `filter_control` — Quyết định S7 #6), zod theo `type`, kiểm lúc lưu với base hiện tại (table/field còn dùng, field đúng table, dimension nhóm được, ngày có bucket, aggregation hợp field, filter mode `standard`, `filter_bindings` trỏ `filter_control` cùng dashboard). Xoá table/field **không** xoá dây chuyền: widget giữ config và đọc ra `broken` (`table_deleted` | `field_deleted`).
- **Thùng rác** 30 ngày như table (Quyết định S7 #22), dọn trong cron `maintenance.cleanup` có sẵn — không job mới, không tra cứu vượt tenant mới.
- **Quyền** (S§10, Quyết định S7 #4): đọc = base owner/admin, role hệ thống editor/reader, role custom có `dashboards.<id> = read_only`; sửa = base owner/admin. `BASE_SCHEMA_META` nạp id dashboard ngoài thùng rác để preset/resolve có danh sách thật. Dashboard mới **không** tự vào role custom (deny-by-default như table). Không đọc được → `404`, đọc được nhưng sửa → `403`.
- **Scope token** (Quyết định S7 #24): `GET` dashboard/widget → `schema:read`; dữ liệu widget, giá trị filter control, click-through, CSV → `records:read`; ghi → `schema:write`; share link dashboard → chỉ session.
- **Audit/event** `dashboard.created|updated|deleted|restored|duplicated` + `dashboard.widget_created|widget_updated|widget_deleted`: before/after là **cấu hình**, không bao giờ giá trị record. Filter đã lưu của widget chỉ trả cho base admin (người xem khác nhận `null`; server vẫn áp) vì giá trị trong filter là dữ liệu của table.

### 2. Truy vấn widget một cửa (T806)

`POST /widgets/:id/data` → kiểm quyền dashboard → planner thuần dựng truy vấn chuẩn hoá từ config + filter thời gian thực (chỉ nguồn dashboard khai báo) → `RecordAccessContext` của người xem → một hàm aggregate mới cạnh `summaries` trong `server-core/src/records/**` (WHERE của records/query + read rule; bucket ngày theo múi giờ hiệu lực; top N + "Khác" bằng window; `SET LOCAL statement_timeout` 10 s). Field người xem không đọc được ở dimension/metric/filter → trạng thái "Không có quyền", không chạy SQL, không lộ số. `count_distinct` chính xác (không HLL — extension mới; lấy mẫu sai nặng). Không materialized view (không theo quyền từng người).

### 3. Cache và realtime (T807)

Valkey (ADR-07): khoá = hash(truy vấn chuẩn hoá) + dấu vân tay quyền **đã thay biến** của table nguồn + `data_version`; không id user dạng rõ, không giá trị; không tính được dấu vân tay → không cache (fail closed). Chỉ lưu kết quả aggregate (≤ 1.000 nhóm), TTL 5 phút (chỉ để dọn — `data_version` bảo đảm không phục vụ số cũ), gom miss trùng bằng `SET NX` 10 s. Kênh WS `dashboard:{id}` chỉ mang **gợi ý** làm mới (gom 5 s), không mang giá trị; mỗi client refetch theo quyền của mình.

### 4. Chia sẻ và nhúng (T809), export qua link (T810)

Link dashboard dùng quyền **hiện tại** của người tạo ∩ widget của dashboard (`packages/permissions/src/share-link.ts`); config trả qua link bỏ filter đã lưu; filter thời gian thực chỉ khi `allow_filter_controls` và chỉ trên field dashboard nêu (khác → `403 NOT_ALLOWED`, như C§16A). Nhúng: API phục vụ trang nhúng khi URL có `embed=1` với CSP `frame-ancestors` theo `allowed_origins` của link (các trang khác giữ `frame-ancestors 'none'`); chỉ link `public` không mật khẩu (cookie mở khoá `SameSite=Strict` không đi trong iframe bên thứ ba). Export qua link view là khoá riêng `allow_export` (không dùng lại `allow_download` của tệp).

**Ghi chú triển khai (T809).** API không có bản build web, nên "API phục vụ trang nhúng" là: nginx chuyển `/s/{token}?embed=1` tới `GET /api/v1/shares/{token}/page`, API trả header (CSP với `frame-ancestors` của link hoặc `'none'` + `X-Frame-Options: DENY`) cùng `X-Accel-Redirect: /_share/embed`, nginx phục vụ `share.html` ở location nội bộ đó với header API trả (`vite preview` làm tương tự). `refresh_seconds` 30..3600. Nguồn filter mà dashboard không khai báo qua link → `403 NOT_ALLOWED` (thành viên: `422`). Widget qua link có giới hạn riêng 120 request/10 s/IP và một hàng đợi truy vấn mỗi link.

### 5. Thư viện (frontend, T811–T813)

ECharts (Apache-2.0, tương thích AGPL-3.0 một chiều) import theo module (`echarts/core` + chart/component dùng) — đủ combo hai trục, chồng 100 %, ARIA + decal, theme tối, PNG trong ngân sách route dashboard 350 KB (trần làm việc 300 KB); react-grid-layout 2.x (MIT, ≈ 25 KB) cho lưới, di chuyển/đổi cỡ bằng bàn phím tự làm. Cả hai chỉ trong chunk `features/dashboard/**`. Không thêm thư viện chart/animation khác.

## Phương án đã cân nhắc

- **`layout jsonb` trên dashboard** (SPEC §5.10 cũ): hai nguồn (widget + layout) phải giữ khớp, xoá widget để rác; bỏ.
- **Xoá widget dây chuyền khi xoá field/table**: mất cấu hình khi người dùng khôi phục field từ thùng rác; chọn `broken` khi đọc.
- **Aggregate ở client từ record**: cần giá trị thô (lộ dữ liệu, chậm); **materialized view / `pg_ivm`**: tính trên toàn bảng, không theo record rule từng người, `pg_ivm` chặn ghi; bỏ cả hai.
- **HLL cho `count_distinct`**: extension mới, sai số; bỏ — chính xác + timeout.
- **Đẩy kết quả qua WS**: mỗi người một kết quả theo quyền, payload WS không được mang dữ liệu; chỉ gợi ý.
- **Chart.js** (≈ 46–60 KB) nếu ngân sách route phải ≤ 150 KB: phải tự làm ARIA/bảng thay thế, decal, theme tối, combo hai trục — phương án dự phòng ("Câu hỏi mở S7" #2). **Recharts**: không có PNG sẵn. **gridstack**: không sửa được chỉ bằng bàn phím, wrapper React chưa kiểm.
- **nginx `auth_request` cho trang nhúng**: thêm subrequest cho mọi trang share; **kiểm phía client**: không chống được clickjacking.

## Hệ quả

- Một migration duy nhất của S7 (`0053_dashboards`); các task S7 khác lưu cấu hình trong jsonb có sẵn (`meta.views.config`, `meta.share_links.settings`).
- Thêm role custom sau khi có dashboard: dashboard không liệt kê = `no_perm`; admin phải bật từng dashboard (UI T815).
- Mọi route ghi tăng `version` của dashboard: hai người sửa hai widget khác nhau cùng lúc với `If-Match` thì người sau nhận `409` và tải lại — chấp nhận được với ≤ 30 widget và một nhóm nhỏ người sửa (base admin).
- Người xem không phải admin không thấy filter đã lưu của widget; UI chỉ hiển thị mô tả (T811).
- Base trong thùng rác ẩn dashboard của nó; xoá vĩnh viễn base xoá dashboard (FK cascade). Gói base `.chbase` (S9) mang dashboard theo id field.
