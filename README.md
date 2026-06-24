# MaRa CapCut Pro Render Engine (Railway)

Bản này thay **toàn bộ** renderer Playwright/Chromium bằng engine xác định frame (deterministic):

`Node Canvas / Skia (@napi-rs/canvas) → raw BGRA frames → FFmpeg H.264/AAC MP4`

Không có `Playwright`, `Chromium`, screenshot DOM, `requestAnimationFrame` hay `locator.screenshot()`. Máy chủ có thể render chậm hơn với video dài, nhưng frame luôn đúng thứ tự 30 FPS và không kẹt vì trình duyệt headless.

## File cần có ở root GitHub repo Railway

```text
Dockerfile
package.json
railway.toml
src/server.js
src/render/engine.js
src/render/draw.js
src/render/timeline.js
src/render/utils.js
```

## Railway Variables

```text
FRONTEND_URL=https://slidemara.vercel.app
PUBLIC_BASE_URL=https://mara-railway-renderer-production.up.railway.app
MAX_UPLOAD_MB=300
MAX_VIDEO_SECONDS=180
JOB_TTL_MINUTES=180
MAX_QUEUE=3
```

Không thêm `/health` vào `PUBLIC_BASE_URL`.

## Điều tương thích

* API giữ nguyên: `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/download`, `DELETE /api/jobs/:id`.
* Frontend Vercel hiện tại dùng `src/services/railwayRender.ts` có thể giữ nguyên.
* Hỗ trợ 30 FPS cố định, 720p/1080p, H.264 + AAC, nhạc loop, captions, filters cơ bản, particles, Ken Burns, multi-photo layouts và cinematic transitions.

## Khác biệt cần biết

Bởi vì không còn mở website Vercel để chụp Canvas, các chi tiết **thuần CSS/DOM** bên ngoài engine Canvas sẽ không tự đi vào MP4. Renderer backend đã tái tạo các tính năng animation/transition đang lưu trong `Slide`/project JSON. Những hiệu ứng mới ở frontend cần được thêm tương ứng vào `src/render/draw.js` để có trong video server.

## Test đầu tiên

1. Deploy Railway thành công.
2. Mở `/health`: cần thấy `rendererVersion: "capcut-pro-2"` và `engine: "deterministic-node-canvas-ffmpeg"`.
3. Test 2–3 ảnh, 720p, không nhạc.
4. Sau đó dùng 1080p / Cân bằng.

## Nên dùng

* `720p / smooth`: test nhanh.
* `1080p / balanced`: TikTok, Reels, Facebook.
* `1080p / quality`: video quan trọng; render lâu hơn.
