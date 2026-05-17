# Auto TikTok Uploader

Tool Node.js dùng Playwright để tự động đăng video TikTok trên Chrome bằng các profile người dùng có sẵn.

## Mục tiêu

- Chọn user/profile trước khi chạy.
- Mở Chrome bằng profile đã đăng nhập TikTok sẵn.
- Đọc danh sách video từ Google Sheet.
- Tìm video chưa đăng, upload file từ máy local.
- Tự điền caption và các tuỳ chọn đăng cơ bản.
- Cập nhật trạng thái ngược lại Google Sheet sau khi đăng.
- Retry khi upload/post lỗi.
- Lưu log để debug từng lần chạy.

## Luồng hoạt động đề xuất

1. Người dùng chạy tool bằng CLI.
2. Tool hiển thị danh sách user TikTok đã cấu hình.
# Auto TikTok Uploader

Phiên bản README này tóm tắt flow vận hành theo yêu cầu của bạn và hướng dẫn cấu hình để chạy hiện tại.

**Tóm tắt flow (hiện tại)**
- Tool đọc Google Sheet và với mỗi dòng có `video_path` và `status` khác `DONE` sẽ thực hiện upload ngay (lập lịch sẽ phát triển sau).
- Người dùng chọn URL / user upload qua CLI (có thể nâng cấp lên UI sau). Gợi ý lưu cấu hình user ở `config/users.json`.
- Tool mở Chrome bằng profile tương ứng (thư mục `chrome-profiles` ngang hàng với project), vào trang upload, upload video, sửa caption dựa trên Google Sheet.
- Trên màn hình TikTok Studio: tool sẽ tắt âm thanh gốc (remove original sound) rồi chọn ngẫu nhiên 1 bản nhạc từ danh sách Favorites mà bạn lưu sẵn.
- Sau upload, tool sẽ kiểm tra 2 nút xác minh (vi phạm nhạc và vi phạm chính sách). Kết quả sẽ quyết định ghi `DONE` hay `ERROR` trên sheet.

## Luồng chi tiết theo yêu cầu
1. Đọc Google Sheet: lọc dòng có `video_path` không rỗng và `status` != `DONE`.
2. Chọn URL/user: CLI hiển thị các user từ `config/users.json`; người dùng chọn một user (hoặc truyền cờ CLI). Sau này có thể chuyển việc chọn này lên UI.
3. Mở Chrome với profile của user (ví dụ `../chrome-profiles/<user>`). Nếu profile chưa đăng nhập TikTok, cần đăng nhập thủ công 1 lần.
4. Vào trang upload (TikTok Studio) — URL có thể cấu hình trong `config/users.json` hoặc `.env`.
5. Upload file video theo `video_path` và tự động điền `caption` từ Google Sheet.
6. Chuyển sang phần edit audio: tắt âm thanh gốc (remove original sound), sau đó chọn 1 bản nhạc ngẫu nhiên từ Favorites.
7. (Tương lai) Set lịch đăng nếu `scheduled_at` có giá trị — hiện chưa triển khai.
8. Kiểm tra vi phạm: tool sẽ bấm 2 nút kiểm tra và đọc kết quả; nếu vi phạm thì ghi `ERROR` và dừng video đó, nếu không thì tiếp tục đăng và ghi `DONE` và `tiktok_url`.

## Đề xuất cấu hình
- File cấu hình người dùng: `config/users.json` (dùng `config/users.example.json` làm mẫu). Ví dụ:

```json
[
  {
    "name": "user_1",
    "chromeUserDataDir": "../chrome-profiles/user_1",
    "sheetName": "Videos",
    "uploadUrl": "https://www.tiktok.com/tiktokstudio/upload"
  }
]
```

- Thư mục Chrome profiles: tạo `chrome-profiles` ở ngang hàng với project root (ví dụ cùng cấp với `auto_post_toptop`). Mỗi user 1 subfolder.

## Google Sheet - Schema tối thiểu
- `id` — id dòng
- `user` — tên user tương ứng
- `video_path` — đường dẫn video (tương đối với `VIDEO_ROOT` hoặc tuyệt đối)
- `caption` — caption để điền
- `status` — `PENDING` | `UPLOADING` | `DONE` | `ERROR`
- `scheduled_at` — (tùy) thời điểm muốn đăng
- `posted_at` — thời gian đăng thành công
- `tiktok_url` — link video sau khi đăng

Lưu ý: sheet hiện giờ không cần cột `user`. Thay vào đó mỗi user có thể có 1 sheet (tab) riêng — cấu hình `user.sheetName` trong `config/users.json` chỉ tới sheet cho user đó.

Flow quyết định: tool chỉ xử lý các dòng `status` != `DONE`.

## Hướng dẫn cài đặt nhanh
1. Cài Node.js (phiên bản LTS). Rồi chạy:

```powershell
npm install
```

2. Bảo đảm `credentials/google-service-account.json` chứa service account nếu dùng service account, và share Google Sheet cho email service account.
3. Copy và chỉnh `config/users.example.json` → `config/users.json`.
4. Tạo `chrome-profiles/` ngang hàng với project và cho mỗi user 1 folder (hoặc để Playwright tạo sau và đăng nhập thủ công 1 lần).
5. Đặt `VIDEO_ROOT` trong `.env` nếu bạn dùng path tương đối.

Chạy inspect/upload thử:

```powershell
npm run inspect-upload
```

hoặc CLI (tùy script hiện có):

```powershell
npm run start -- --user user_1
```

## Ghi chú vận hành
- Không dùng profile Chrome đang mở trong trình duyệt chính; nên dùng profile riêng cho automation.
- Nếu profile mới, mở thủ công và đăng nhập TikTok một lần.
- Mỗi bước UI (upload, edit audio, check violations) cần selectors ổn định; tách selectors vào `src/tiktok/selectors.js`.
- Khi phát hiện vi phạm nhạc/chính sách, tool nên ghi `ERROR` trên sheet và lưu log chi tiết.

## Về `inspectUpload.js`
- `src/cli/inspectUpload.js` hiện đã có phần code để inspect UI và thử luồng upload — dùng file này làm reference khi tách các bước hàm: `openProfile`, `navigateToUpload`, `uploadVideo`, `applyCaption`, `removeOriginalSound`, `pickFavoriteMusic`, `checkViolations`, `updateSheet`.

## Bước tiếp theo (gợi ý)
Bạn muốn tôi thực hiện tiếp theo nào trong danh sách dưới đây?
1) Refactor `src/cli/inspectUpload.js` thành các hàm mô-đun theo flow ở trên.
2) Tạo mẫu `config/users.json` và script CLI để chọn user.
3) Viết module small để đọc sheet + dry-run và log kết quả.

Nói tôi biết bạn chọn gì, tôi sẽ tiếp tục.
