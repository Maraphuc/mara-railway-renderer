# MaRa Railway Renderer — MP4 H.264/AAC server render

Dịch vụ này chạy riêng trên **Railway**, còn website MaRa Slide tiếp tục chạy trên **Vercel**.

Luồng render:

```text
MaRa Slide (Vercel)
  → upload ảnh + nhạc + timeline lên Railway
  → Railway mở đúng trang MaRa Slide bằng Chromium headless
  → dùng chính Canvas renderer hiện tại để vẽ từng khung hình 30 FPS
  → FFmpeg tạo MP4 H.264 + AAC
  → trả link tải MP4 về web
```

Nhờ vậy hiệu ứng Canvas trong Preview, layout nhiều ảnh, caption, blur, particle và transition được giữ theo đúng code website hiện có. Máy người dùng chỉ upload và theo dõi tiến trình; không phải encode MP4.

## Điểm cần biết

- Mỗi Railway service chỉ render **1 job tại một thời điểm** để tránh giật/thiếu RAM.
- Dự án mặc định giới hạn **180 giây** và upload tối đa **300 MB**. Có thể chỉnh qua biến môi trường.
- File ảnh, nhạc và MP4 chỉ nằm tạm trên filesystem Railway, tự dọn sau 180 phút. Không phải kho lưu trữ lâu dài.
- Phải khai báo chính xác `FRONTEND_URL` và `PUBLIC_BASE_URL` trước khi render.

## Deploy Railway bằng GitHub

1. Tạo một repository GitHub mới, ví dụ `mara-railway-renderer`.
2. Upload toàn bộ thư mục này lên repository mới.
3. Railway → **New Project** → **Deploy from GitHub repo** → chọn repository đó.
4. Railway tự nhận `Dockerfile`. Đợi build xong.
5. Railway → service → **Networking** → **Generate Domain**.
6. Copy domain Railway vừa tạo, ví dụ:

```text
https://mara-railway-renderer-production.up.railway.app
```

7. Railway → service → **Variables**, tạo các biến sau:

```text
FRONTEND_URL=https://slidemara.vercel.app
PUBLIC_BASE_URL=https://DAN_DOMAIN_RAILWAY_CUA_BAN
MAX_UPLOAD_MB=300
MAX_VIDEO_SECONDS=180
JOB_TTL_MINUTES=180
MAX_QUEUE=4
```

`PUBLIC_BASE_URL` phải là domain Railway có `https://`, không có dấu `/` ở cuối.

8. Sau khi thêm biến, Railway sẽ deploy lại. Mở đường dẫn:

```text
https://DAN_DOMAIN_RAILWAY_CUA_BAN/health
```

Bạn phải thấy JSON có `"ok": true`.

## Kết nối Vercel

Trong Vercel:

1. Vào project `slidemara` → **Settings** → **Environment Variables**.
2. Thêm:

```text
Name: VITE_RENDER_API_URL
Value: https://DAN_DOMAIN_RAILWAY_CUA_BAN
Environment: Production, Preview, Development
```

3. Bấm **Redeploy** project Vercel.

Sau khi Vercel deploy xong, nút `Render MP4 Railway` trong MaRa Slide sẽ gửi project sang Railway.

## Chất lượng video

- **Mượt · 30 FPS**: FFmpeg `veryfast`, CRF 20. Nhanh hơn, file nhỏ hơn.
- **Cân bằng · 30 FPS**: FFmpeg `medium`, CRF 18. Khuyến nghị cho TikTok/Reels.
- **Nét tối đa · 30 FPS**: FFmpeg `slow`, CRF 17. Render lâu hơn và tốn CPU hơn.

Ở 9:16:

- 720p = `720 × 1280`
- 1080p = `1080 × 1920`

## Nếu Railway không render được

Kiểm tra lần lượt:

1. `FRONTEND_URL` là `https://slidemara.vercel.app`.
2. `PUBLIC_BASE_URL` là domain Railway public hiện tại.
3. Vercel đã được deploy bản frontend patch có `maraRender=1`.
4. `VITE_RENDER_API_URL` trên Vercel trùng với `PUBLIC_BASE_URL`.
5. Test `/health` và mở log Railway.

Nếu error có chữ `Canvas renderer chưa sẵn sàng`, thường là Vercel đang dùng CanvasPlayer/App cũ hoặc app không tải được ảnh từ Railway.

## Bảo mật và giới hạn

Bản đầu dùng CORS, token job ngẫu nhiên, giới hạn tần suất và chỉ xử lý một job một lúc. Đây là mức phù hợp cho website dùng nội bộ. CORS không phải cơ chế xác thực tuyệt đối; trước khi mở công khai cho nhiều người, nên thêm đăng nhập server-side hoặc proxy API qua Vercel bằng secret server-side.
