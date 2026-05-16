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
3. Người dùng chọn user cần đăng.
4. Tool đọc Google Sheet và lọc các dòng:
   - đúng user được chọn
   - trạng thái không phải `DONE` hoặc `ERROR`
   - đường dẫn video local tồn tại
5. Tool mở Chrome bằng profile tương ứng.
6. Tool upload từng video như người dùng thao tác thật.
7. Sau mỗi video, tool cập nhật Google Sheet:
   - `UPLOADING`
   - `DONE`
   - `ERROR`
8. Tool ghi log chi tiết vào thư mục `logs/`.

## Google Sheet Schema Đề Xuất

Sheet nên có các cột sau:

| Column | Ý nghĩa |
| --- | --- |
| `id` | ID duy nhất cho mỗi video |
| `user` | Tên user/profile TikTok dùng để đăng |
| `video_path` | Đường dẫn file video trên máy local |
| `caption` | Nội dung caption |
| `status` | Tool sẽ đăng nếu status không phải `DONE` hoặc `ERROR`; khi chạy sẽ ghi `UPLOADING`, thành công ghi `DONE`, lỗi ghi `ERROR` |
| `scheduled_at` | Thời điểm muốn đăng, có thể để trống |
| `posted_at` | Thời điểm đăng thành công |
| `tiktok_url` | Link video sau khi đăng, nếu lấy được |

## Cấu Hình User Đề Xuất

Mỗi user TikTok nên có một Chrome profile riêng để giữ session đăng nhập.

Ví dụ file `config/users.json`:

```json
[
  {
    "name": "user_1",
    "chromeUserDataDir": "../chrome-profiles/user_1",
    "sheetName": "Videos"
  },
  {
    "name": "user_2",
    "chromeUserDataDir": "../chrome-profiles/user_2",
    "sheetName": "Videos"
  }
]
```

Không commit file cấu hình thật nếu có thông tin nhạy cảm.

## Cấu Trúc Project Đề Xuất

```text
auto_post_toptop/
  README.md
  package.json
  .env.example
  config/
    users.example.json
  src/
    cli/
      index.js
    config/
      loadConfig.js
    google/
      sheetsClient.js
      videoRepository.js
    tiktok/
      uploader.js
      selectors.js
    browser/
      launchChrome.js
    logging/
      logger.js
    utils/
      file.js
      retry.js
  logs/
```

## Công Nghệ

- Node.js
- Playwright
- Google Sheets API
- Inquirer hoặc prompts cho CLI chọn user
- dotenv cho biến môi trường
- pino hoặc winston cho logging

## Biến Môi Trường Đề Xuất

```env
GOOGLE_SHEET_ID=
GOOGLE_APPLICATION_CREDENTIALS=
VIDEO_ROOT=../videos
TIKTOK_UPLOAD_URL=https://www.tiktok.com/tiktokstudio/upload?from=creator_center&tab=video
HEADLESS=false
UPLOAD_LIMIT_PER_RUN=5
```

## Ghi Chú Vận Hành

- Nên dùng Chrome profile riêng cho automation để có thể mở Chrome `Default` làm việc khác cùng lúc.
- Không chạy song song cùng một automation profile.
- Nếu TikTok Studio yêu cầu login trong automation profile, login thủ công trong cửa sổ Chrome tool mở rồi chạy lại.
- Nên giới hạn số video mỗi lần chạy để giảm rủi ro lỗi và dễ kiểm soát.
- Nên thêm delay ngẫu nhiên nhẹ giữa các thao tác để giống hành vi người dùng hơn.
- UI TikTok có thể thay đổi, nên selector cần tách riêng trong `src/tiktok/selectors.js`.

## Quyết Định Cần Chốt

- Google Sheet dùng OAuth cá nhân hay service account?
- Video local nằm trong một thư mục cố định hay mỗi dòng có đường dẫn đầy đủ?
- Tool chỉ chạy CLI hay cần giao diện web nhỏ để chọn user?
- Có cần đặt lịch đăng theo `scheduled_at` hay chỉ đăng ngay các dòng chưa `DONE`/`ERROR`?
- Sau khi đăng xong có cần di chuyển file video sang thư mục archive không?

## Bước Setup Hiện Tại

1. Copy `.env.example` thành `.env`.
2. Điền `GOOGLE_SHEET_ID` trong `.env`.
3. Tạo Google service account, tải file JSON vào `credentials/google-service-account.json`.
4. Share Google Sheet cho email service account với quyền Editor.
5. Copy `config/users.example.json` thành `config/users.json`.
6. Sửa `name`, `chromeUserDataDir`, `sheetName` cho từng user.
7. Chạy `npm install`.
8. Chạy thử bằng `npm run dry-run`.
9. Inspect UI TikTok Studio bằng `npm run inspect-upload` khi cần cập nhật selector.

Có thể inspect trực tiếp user `quan_ao` bằng:

```bash
npm run inspect-upload:quan-ao
```

Mặc định tool đang để `DRY_RUN=true`, nghĩa là chỉ đọc sheet, chọn user, kiểm tra video local và mở luồng chạy thử. Khi đã sẵn sàng đăng thật, đổi `DRY_RUN=false`.

`chromeUserDataDir` là thư mục riêng tool dùng để chạy automation, ví dụ `../chrome-profiles/user_1`.

Không dùng thư mục Chrome chính của trình duyệt (ví dụ `/Users/<you>/Library/Application Support/Google/Chrome`) khi Chrome đang mở. Nếu dùng thư mục chính, Playwright có thể mở vào phiên trình duyệt hiện tại rồi đóng ngay, hoặc báo lỗi profile đang bị đóng.

Nếu bạn thấy Chrome mở ra trắng và không hiện user, đó là vì `chromeUserDataDir` đang dùng một profile mới, chưa chứa đăng nhập TikTok. Bạn cần đăng nhập thủ công một lần vào profile này, hoặc copy profile Chrome đã đăng nhập vào thư mục automation trước khi chạy.

TikTok Studio web có thể truy cập qua `https://www.tiktok.com/tiktokstudio`. Tool dùng `TIKTOK_UPLOAD_URL` cho bước upload để dễ chỉnh khi giao diện TikTok thay đổi.

## Video Local

Nên để thư mục video nằm ngang hàng với project:

```text
Auto_TopTop/
  auto_post_toptop/
  videos/
    ao_quan/
      ao_quan_001.mp4
      ao_quan_002.mp4
    do_an/
      do_an_001.mp4
```

Khi đó `.env` dùng:

```env
VIDEO_ROOT=../videos
```

Trong Google Sheet, cột `video_path` chỉ cần điền path tương đối:

```text
ao_quan/ao_quan_001.mp4
do_an/do_an_001.mp4
```

Trên Windows, chỉ cần đổi `VIDEO_ROOT` trong `.env` của máy Windows, còn Google Sheet giữ nguyên.
