# Worker วิเคราะห์เสียงและฟอร์เมชัน

โฟลเดอร์นี้มีบริการ Python ที่เว็บเรียกใช้เพื่อวิเคราะห์เสียงและฟอร์เมชัน Worker แยก process จาก Next.js; เว็บค้นหาและเล่น YouTube ได้โดยไม่ต้องเปิด worker แต่การวิเคราะห์ใหม่ต้องเปิด worker ไว้

## ข้อกำหนด

- Python 3.11 ขึ้นไป
- FFmpeg พร้อมใช้งานจาก `PATH`
- `requirements-fast.txt` สำหรับวิเคราะห์เสียงโหมดเร็ว
- `requirements-formation-yolo.txt` สำหรับวิเคราะห์ฟอร์เมชันด้วย Ultralytics/YOLO26s-pose

แนะนำให้ติดตั้งใน Ubuntu/WSL บน Windows เพื่อแยก dependency ออกจาก Node.js และเว็บ

## ติดตั้งและเปิด

```bash
cd services/audio-analysis
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-fast.txt
python -m pip install -r requirements-formation-yolo.txt
cd ../..
python services/audio-analysis/server.py
```

ครั้งแรกที่ติดตั้ง formation จะดาวน์โหลด PyTorch/Ultralytics และครั้งแรกที่วิเคราะห์จะดาวน์โหลดน้ำหนักโมเดล จึงต้องมีอินเทอร์เน็ตและพื้นที่ดิสก์เพียงพอ หากใช้เฉพาะวิเคราะห์เสียง ให้ติดตั้ง `requirements-fast.txt` เท่านั้น

Worker รับคำขอที่ `127.0.0.1:8765` เป็นค่าเริ่มต้น ตรวจสถานะได้ที่:

```bash
curl http://127.0.0.1:8765/health
```

ผลควรมี `status: ok`, `engine` และ `cpuThreads` ตั้ง `AUDIO_ANALYSIS_URL=http://127.0.0.1:8765` ใน `.env.local` ของเว็บ แล้ว restart Next.js หลังเปลี่ยนค่า

## ตัวแปรแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
| --- | --- | --- |
| `AUDIO_ANALYSIS_PORT` | `8765` | port ที่ worker เปิด |
| `AUDIO_ANALYSIS_ENGINE` | `fast` | โหมดวิเคราะห์เสียง: `fast` หรือ `full` |
| `AUDIO_ANALYSIS_THREADS` | `6` | จำนวนเธรดสูงสุดที่ร้องขอ; ค่าจริงถูกจำกัดด้วย CPU ที่มี |
| `AUDIO_ANALYSIS_CACHE` | `~/.cache/muverse-audio` | โฟลเดอร์แคชผลฟอร์เมชัน |
| `AUDIO_ANALYSIS_TOKEN` | ว่าง | token ตรวจสิทธิ์เมื่อเชื่อมผ่านบริการที่ตั้งค่ารองรับ |

`AUDIO_ANALYSIS_URL` เป็นค่าฝั่งเว็บ ไม่ใช่ค่าที่กำหนด port ภายใน worker

## วิเคราะห์เสียง

โหมด `fast` ถอดรหัสเสียงชั่วคราวและเทียบรูปแบบซ้ำ เช่น chroma, timbre, RMS และกิจกรรมเสียง เพื่อเสนอช่วงที่อาจเป็นท่อนฮุค โหมดนี้ไม่ใช้โมเดลหนัก Demucs/NATTEN และไม่ได้ยืนยันว่าเป็นท่อนฮุคจริง เพลงที่โครงสร้างเปลี่ยนหรือไม่มีช่วงซ้ำอาจไม่พบผล

Worker กำหนดเวลางานเสียงรวมสูงสุด 27 วินาทีสำหรับ `fast` และ 180 วินาทีสำหรับ `full` โดยเวลาจริงยังขึ้นกับการดาวน์โหลดและสภาพแวดล้อม งานที่ไม่ polling ต่อจะหมด lease เพื่อไม่ให้คิวเก่าค้าง ผลเสียงไม่บันทึกเป็นแคชถาวร ส่วนผลฟอร์เมชันเก็บในแคช worker ตาม video ID และ calibration key

ข้อมูล chapter/ความเห็นของ YouTube และเนื้อเพลงที่มีเวลาถูกประมวลผลผ่าน API routes ฝั่งเว็บ ไม่ใช่ส่วนที่ worker สร้างขึ้นเอง ผลที่รวมกันอาจไม่มีหรือคลาดเคลื่อน ผู้ใช้ตรวจและแก้ช่วง A–B ได้

## วิเคราะห์ฟอร์เมชัน

เว็บส่ง video ID และมุมพื้นเวทีที่ผู้ใช้กำหนดทั้งสี่จุด Worker ดึงวิดีโอชั่วคราว สุ่มตัวอย่างเฟรม ใช้ YOLO26s-pose ประเมิน keypoints และประมาณตำแหน่งเท้าบนพื้น ก่อนแปลง perspective ตามมุมเวทีและจัดกลุ่มตำแหน่งเป็นไทม์ไลน์

การวิเคราะห์แต่ละคลิปมีเวลาสูงสุด 900 วินาที จุดที่ถูกบัง สะท้อน อยู่นอกกรอบ หรือภาพไม่ชัดอาจตรวจพลาด YOLO ตรวจ pose ไม่ได้ยืนยันว่าใครเป็นบุคคลใด จึงมี editor ให้ผู้ใช้แก้จุดและชื่อหลังวิเคราะห์

## ขอบเขตความปลอดภัยและข้อมูล

- Worker bind เฉพาะ `127.0.0.1` ห้ามเปิดพอร์ตนี้ต่ออินเทอร์เน็ตโดยตรง
- หากเชื่อมข้ามเครื่อง ให้ใช้ HTTPS/reverse proxy, ตั้ง token ให้ตรงกันทั้งเว็บและ worker และจำกัดผู้เรียก
- ไฟล์สื่อและไฟล์ชั่วคราวสำหรับวิเคราะห์ถูกลบเมื่อเสร็จหรือยกเลิก ส่วนผลฟอร์เมชันเก็บในแคชฝั่ง worker ตามอายุที่กำหนด
- เพลย์ลิสต์ ไฮไลท์ที่แก้ ฟอร์เมชันที่แก้ และ calibration เก็บใน localStorage ของเบราว์เซอร์ ไม่ได้ sync กับ worker หรือเครื่องอื่น
- อย่า commit `.venv`, API keys, token, cache หรือไฟล์สื่อ

## เมื่อมีปัญหา

- `dependency-missing` — ตรวจว่าเปิด venv และติดตั้ง requirements ให้ตรงกับงาน
- `tool-missing` — ตรวจ `ffmpeg -version` และ PATH
- worker ต่อไม่ได้ — ตรวจ process, `AUDIO_ANALYSIS_PORT`, `AUDIO_ANALYSIS_URL` และ `Invoke-RestMethod http://127.0.0.1:8765/health`
- ดาวน์โหลดไม่สำเร็จ — YouTube อาจจำกัดการเข้าถึงหรือคลิปนั้นไม่พร้อมให้ดาวน์โหลดเพื่อวิเคราะห์ ลองภายหลังและปฏิบัติตามข้อกำหนดของบริการ
- port ถูกใช้อยู่ — ใช้ worker ที่เปิดไว้แล้วหรือหยุด process เดิมด้วย **Ctrl+C** ก่อน

ดูขั้นตอนติดตั้งเว็บ/WSL และคู่มือส่งต่องานที่ [DEVELOPER_GUIDE.md](../../docs/DEVELOPER_GUIDE.md)
