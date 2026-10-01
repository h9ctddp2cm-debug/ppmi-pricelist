# PPMI 復康用品價目平台

部門與供應商共用的復康用品參考價目平台。

- **供應商**：每間公司有一條專屬連結（`#/s/<代碼>`），只能看到及修改自己的產品 — 改價錢、規格、備註，標示「已停售」或新增產品；每次儲存自動記錄時間。
- **部門**：密碼登入後看到所有公司的最新價目、每項的最後更新時間、停售狀況、更改記錄，並可一鍵匯出 Excel（紅＝新增、綠＝價格更改、灰刪線＝已停售）。「產品網頁」及「網上標價」欄只有部門看到，方便比較報價單價格與公開網頁價格。
- 「PPMI 報價」預設為「瀏覽」模式：按產品類別、組別、復康公司分類卡引導同事搜尋，點入後只顯示 7 個精簡欄位；「完整表格」模式保留所有欄位（與 Excel 名單相同）。
- 「完整表格」有類別／子類別快速篩選、搜尋、排序；頂部「公價參考」掣連去部門公價網站，並按型號自動配對公價網站的產品，直接在表格顯示公價。手機版自動變成卡片式顯示。
- 介面可切換中文／English／中英對照；表格字體可用「+／−」放大縮小；電話號碼可直接點按撥打。

## 技術架構

| 部分 | 技術 | 位置 |
| --- | --- | --- |
| 前端 | 純 HTML / CSS / JavaScript（hash 路由，無需 build） | 此 repo，由 GitHub Pages 寄存 |
| 資料庫 | Supabase（PostgreSQL，免費方案） | `supabase/001_schema.sql` |
| API | Supabase RPC（`SECURITY DEFINER` 函數） | 同上 |
| 匯出 Excel | ExcelJS（瀏覽器端，CDN 載入） | `app.js` |

所有資料表都開啟了 Row Level Security 且沒有任何 policy，所以前端的 publishable key **不能**直接讀寫資料表；一切讀寫只能經過 `admin_*`、`supplier_*` 函數：

- `supplier_*` 函數以供應商專屬代碼（token）識別身份，只能存取該公司的資料
- `admin_*` 函數需要登入後取得的 session token（12 小時有效）；密碼以 bcrypt 儲存
- 內部 `_*` 函數已撤銷 anon 的執行權限

## 檔案

```
index.html, style.css, app.js   前端
config.js                       Supabase 專案網址及 publishable key
supabase/001_schema.sql         資料表、RLS、API 函數（可重複執行）
supabase/003_internal_fields.sql 部門內部欄位（產品網頁、網上標價）、最後更新日期設定
images/                         仁濟醫院院徽
supabase/002_seed.sql           由原本 Excel 名單產生的初始資料
scripts/parse_excel.py          由 Excel 產生 data/seed.json（再手動轉為 SQL）
```

## 本機測試

任何靜態伺服器即可，例如：

```bash
python3 -m http.server 8080
# 開啟 http://localhost:8080
```

## 更改部門密碼

登入後到「設定」→「更改部門密碼」。忘記密碼時，可在 Supabase SQL Editor 執行：

```sql
update settings set value = extensions.crypt('新密碼', extensions.gen_salt('bf')) where key = 'admin_password';
```

## 重新由 Excel 匯入（會清除所有網上更新，請小心）

```bash
python3 scripts/parse_excel.py path/to/list.xlsx   # 產生 data/seed.json
```

再將 JSON 轉為 INSERT 語句於 Supabase SQL Editor 執行（請勿把含供應商資料的檔案提交到公開 repo）。
