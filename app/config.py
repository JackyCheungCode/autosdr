"""Central config. Everything env-driven; safe defaults; demo-time controls."""
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
# .env.local (never committed) overrides .env — real credentials live there on
# the demo machine; the committed .env carries judge-testing config only.
load_dotenv(ROOT / ".env.local", override=True)

DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "autosdr.db"
# When set, use Supabase PostgreSQL instead of local SQLite. Keep this server-side.
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

# LLM
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
MODEL_REASON = os.getenv("MODEL_REASON", "")          # resolved at startup if blank
MODEL_FAST = os.getenv("MODEL_FAST", "")
MODEL_EMBED = os.getenv("MODEL_EMBED", "text-embedding-3-small")

# Discovery
SERPER_API_KEY = os.getenv("SERPER_API_KEY", "")
HUNTER_API_KEY = os.getenv("HUNTER_API_KEY", "")

# Email
EMAIL_MODE = os.getenv("EMAIL_MODE", "sim").lower()   # sim | live
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_APP_PASSWORD = os.getenv("SMTP_APP_PASSWORD", "")
IMAP_HOST = os.getenv("IMAP_HOST", "imap.gmail.com")
EMAIL_ALLOWLIST = {
    e.strip().lower() for e in os.getenv("EMAIL_ALLOWLIST", "").split(",") if e.strip()
}

# WhatsApp
WHATSAPP_MODE = os.getenv("WHATSAPP_MODE", "sim").lower()
ADMIN_WHATSAPP = os.getenv("ADMIN_WHATSAPP", "")
GREENAPI_INSTANCE_ID = os.getenv("GREENAPI_INSTANCE_ID", "")
GREENAPI_TOKEN = os.getenv("GREENAPI_TOKEN", "")
TWILIO_SID = os.getenv("TWILIO_SID", "")
TWILIO_TOKEN = os.getenv("TWILIO_TOKEN", "")
TWILIO_WA_FROM = os.getenv("TWILIO_WA_FROM", "")
CALLMEBOT_APIKEY = os.getenv("CALLMEBOT_APIKEY", "")

# Meetings / booking
BOOKING_BASE_URL = os.getenv("BOOKING_BASE_URL", "http://localhost:8000").rstrip("/")
MEETING_PROVIDER = os.getenv("MEETING_PROVIDER", "jitsi")

# Demo time controls
SECONDS_PER_DAY = float(os.getenv("SECONDS_PER_DAY", "60"))
FOLLOWUP_AFTER_DAYS = float(os.getenv("FOLLOWUP_AFTER_DAYS", "3"))
MEETING_REMINDER_MINUTES = float(os.getenv("MEETING_REMINDER_MINUTES", "30"))


def followup_delay_seconds() -> float:
    return FOLLOWUP_AFTER_DAYS * SECONDS_PER_DAY


def reminder_lead_seconds() -> float:
    # 30 "minutes" scaled by the same demo clock (1440 min/day)
    return MEETING_REMINDER_MINUTES * (SECONDS_PER_DAY / 1440.0)
