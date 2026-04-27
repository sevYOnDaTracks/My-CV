from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from uuid import uuid4
from urllib.error import URLError
from urllib.request import Request, urlopen

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "llama3.1"
BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
DATA_DIR = PROJECT_DIR / "data"
DATABASE_PATH = DATA_DIR / "generator_cv.db"

app = FastAPI(title="Générator CV")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


class ProfileItem(BaseModel):
    title: str = ""
    organization: str = ""
    period: str = ""
    description: str = ""
    tags: str = ""
    include: bool = True


class SkillGroup(BaseModel):
    name: str = ""
    skills: str = ""
    include: bool = True


class Profile(BaseModel):
    name: str = ""
    target_title: str = ""
    location: str = ""
    email: str = ""
    phone: str = ""
    links: str = ""
    summary: str = ""
    skills: str = ""
    skill_groups: list[SkillGroup] = Field(default_factory=list)
    languages: str = ""
    education: str = ""
    experiences: list[ProfileItem] = Field(default_factory=list)
    education_items: list[ProfileItem] = Field(default_factory=list)


class GenerateRequest(BaseModel):
    profile: Profile
    job_offer: str
    profile_mode: str = "auto"
    use_ollama: bool = False


class GenerateResponse(BaseModel):
    html: str
    keywords: list[str]
    match_score: int
    used_ollama: bool
    note: str = ""


class DraftPayload(BaseModel):
    payload: dict


class ProfilePayload(BaseModel):
    name: str
    mode: str = "hybrid"
    payload: dict


class JobOfferPayload(BaseModel):
    title: str = ""
    company: str = ""
    job_offer: str


class CvDraftPayload(BaseModel):
    title: str
    company: str = ""
    selected_profile_id: str = ""
    job_offer: str = ""
    payload: dict
    generated_html: str = ""
    match_score: int = 0


def init_database() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS drafts (
                id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                mode TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS cv_drafts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                company TEXT NOT NULL,
                selected_profile_id TEXT NOT NULL,
                job_offer TEXT NOT NULL,
                payload TEXT NOT NULL,
                generated_html TEXT NOT NULL,
                match_score INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )


def save_draft_payload(draft_id: str, payload: dict) -> None:
    init_database()
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            INSERT INTO drafts (id, payload, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (draft_id, json.dumps(payload, ensure_ascii=False), now),
        )


def load_draft_payload(draft_id: str) -> dict | None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            "SELECT payload, updated_at FROM drafts WHERE id = ?",
            (draft_id,),
        ).fetchone()

    if not row:
        return None

    return {
        "payload": json.loads(row[0]),
        "updated_at": row[1],
    }


def delete_draft_payload(draft_id: str) -> None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))


def list_profiles_payloads() -> list[dict]:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        rows = connection.execute(
            """
            SELECT id, name, mode, updated_at
            FROM profiles
            ORDER BY updated_at DESC
            """
        ).fetchall()

    return [
        {"id": row[0], "name": row[1], "mode": row[2], "updated_at": row[3]}
        for row in rows
    ]


def create_profile_payload(profile: ProfilePayload) -> dict:
    init_database()
    profile_id = uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    name = profile.name.strip() or "Nouveau profil"
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            INSERT INTO profiles (id, name, mode, payload, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                profile_id,
                name,
                profile.mode,
                json.dumps(profile.payload, ensure_ascii=False),
                now,
                now,
            ),
        )

    return {"id": profile_id, "name": name, "mode": profile.mode, "updated_at": now}


def load_profile_payload(profile_id: str) -> dict | None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            """
            SELECT id, name, mode, payload, updated_at
            FROM profiles
            WHERE id = ?
            """,
            (profile_id,),
        ).fetchone()

    if not row:
        return None

    return {
        "id": row[0],
        "name": row[1],
        "mode": row[2],
        "payload": json.loads(row[3]),
        "updated_at": row[4],
    }


def update_profile_payload(profile_id: str, profile: ProfilePayload) -> dict:
    init_database()
    now = datetime.now(timezone.utc).isoformat()
    name = profile.name.strip() or "Profil sans nom"
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            UPDATE profiles
            SET name = ?, mode = ?, payload = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                name,
                profile.mode,
                json.dumps(profile.payload, ensure_ascii=False),
                now,
                profile_id,
            ),
        )

    return {"id": profile_id, "name": name, "mode": profile.mode, "updated_at": now}


def delete_profile_payload(profile_id: str) -> None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("DELETE FROM profiles WHERE id = ?", (profile_id,))


def list_cv_drafts_payloads() -> list[dict]:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        rows = connection.execute(
            """
            SELECT id, title, company, selected_profile_id, match_score, updated_at
            FROM cv_drafts
            ORDER BY updated_at DESC
            """
        ).fetchall()

    return [
        {
            "id": row[0],
            "title": row[1],
            "company": row[2],
            "selected_profile_id": row[3],
            "match_score": row[4],
            "updated_at": row[5],
        }
        for row in rows
    ]


def create_cv_draft_payload(draft: CvDraftPayload) -> dict:
    init_database()
    draft_id = uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            INSERT INTO cv_drafts (
                id, title, company, selected_profile_id, job_offer, payload,
                generated_html, match_score, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                draft_id,
                draft.title.strip() or "Brouillon CV",
                draft.company.strip(),
                draft.selected_profile_id,
                draft.job_offer,
                json.dumps(draft.payload, ensure_ascii=False),
                draft.generated_html,
                draft.match_score,
                now,
                now,
            ),
        )

    return {"id": draft_id, "updated_at": now}


def load_cv_draft_payload(draft_id: str) -> dict | None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            """
            SELECT id, title, company, selected_profile_id, job_offer, payload,
                   generated_html, match_score, updated_at
            FROM cv_drafts
            WHERE id = ?
            """,
            (draft_id,),
        ).fetchone()

    if not row:
        return None

    return {
        "id": row[0],
        "title": row[1],
        "company": row[2],
        "selected_profile_id": row[3],
        "job_offer": row[4],
        "payload": json.loads(row[5]),
        "generated_html": row[6],
        "match_score": row[7],
        "updated_at": row[8],
    }


def update_cv_draft_payload(draft_id: str, draft: CvDraftPayload) -> dict:
    init_database()
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            UPDATE cv_drafts
            SET title = ?, company = ?, selected_profile_id = ?, job_offer = ?,
                payload = ?, generated_html = ?, match_score = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                draft.title.strip() or "Brouillon CV",
                draft.company.strip(),
                draft.selected_profile_id,
                draft.job_offer,
                json.dumps(draft.payload, ensure_ascii=False),
                draft.generated_html,
                draft.match_score,
                now,
                draft_id,
            ),
        )

    return {"id": draft_id, "updated_at": now}


def delete_cv_draft_payload(draft_id: str) -> None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("DELETE FROM cv_drafts WHERE id = ?", (draft_id,))


def analyze_offer_payload(payload: JobOfferPayload) -> dict:
    profiles = [load_profile_payload(item["id"]) for item in list_profiles_payloads()]
    profiles = [profile for profile in profiles if profile]
    if not profiles:
        return {"error": "Aucun profil disponible"}

    keywords = extract_keywords(payload.job_offer)
    best_profile = max(
        profiles,
        key=lambda profile: score_text(json.dumps(profile["payload"], ensure_ascii=False), keywords),
    )
    score = min(
        100,
        int(
            (
                score_text(json.dumps(best_profile["payload"], ensure_ascii=False), keywords)
                / max(len(keywords), 1)
            )
            * 100
        ),
    )

    draft_payload = best_profile["payload"].copy()
    draft_payload["job_offer"] = payload.job_offer
    draft_payload["profile_mode"] = draft_payload.get("profile_mode") or best_profile["mode"]
    profile = Profile(**draft_payload.get("profile", {}))
    html = build_cv_html(profile, payload.job_offer, keywords, draft_payload["profile_mode"])
    title = payload.title.strip() or f"CV {best_profile['name']}"
    if payload.company.strip():
        title = f"{title} - {payload.company.strip()}"

    draft = CvDraftPayload(
        title=title,
        company=payload.company,
        selected_profile_id=best_profile["id"],
        job_offer=payload.job_offer,
        payload=draft_payload,
        generated_html=html,
        match_score=score,
    )
    created = create_cv_draft_payload(draft)

    return {
        "draft": load_cv_draft_payload(created["id"]),
        "selected_profile": {
            "id": best_profile["id"],
            "name": best_profile["name"],
            "mode": best_profile["mode"],
        },
        "keywords": keywords,
    }


init_database()


STOPWORDS = {
    "avec", "pour", "dans", "des", "les", "une", "sur", "aux", "vous", "nous",
    "que", "qui", "est", "sont", "par", "plus", "chez", "notre", "votre",
    "the", "and", "for", "with", "you", "are", "will", "from", "this", "that",
    "have", "has", "les", "ses", "vos", "nos", "leur", "leurs", "afin",
    "de", "du", "la", "le", "un", "en", "et", "a", "au", "ou", "of", "to",
}

KNOWN_TECHS = {
    "python", "fastapi", "flask", "django", "javascript", "typescript", "react",
    "vue", "angular", "node", "sql", "postgresql", "mysql", "mongodb", "docker",
    "kubernetes", "aws", "azure", "gcp", "spark", "airflow", "dbt", "etl",
    "elt", "pandas", "numpy", "scikit", "tensorflow", "pytorch", "mlops",
    "llm", "rag", "ollama", "api", "rest", "graphql", "git", "ci", "cd",
    "powerbi", "tableau", "excel", "linux", "java", "c#", ".net", "php",
}

SKILL_CATEGORIES = {
    "Langages": {
        "python", "javascript", "typescript", "java", "c#", "php", "sql",
        "html", "css",
    },
    "Backend": {
        "fastapi", "flask", "django", "node", "api", "rest", "graphql", ".net",
    },
    "Frontend": {
        "react", "vue", "angular",
    },
    "Data": {
        "postgresql", "mysql", "mongodb", "spark", "airflow", "dbt", "etl",
        "elt", "pandas", "numpy",
    },
    "IA": {
        "scikit", "tensorflow", "pytorch", "mlops", "llm", "rag", "ollama",
        "machine learning",
    },
    "Cloud / DevOps": {
        "docker", "kubernetes", "aws", "azure", "gcp", "git", "ci", "cd",
        "linux",
    },
    "BI / Analyse": {
        "powerbi", "power bi", "tableau", "excel",
    },
}

MODE_CATEGORY_PRIORITY = {
    "dev": ["Langages", "Backend", "Frontend", "Cloud / DevOps", "Data", "IA", "BI / Analyse", "Autres"],
    "data": ["Langages", "Data", "Cloud / DevOps", "BI / Analyse", "Backend", "IA", "Frontend", "Autres"],
    "ai": ["Langages", "IA", "Data", "Cloud / DevOps", "Backend", "BI / Analyse", "Frontend", "Autres"],
    "hybrid": ["Langages", "Backend", "Data", "IA", "Cloud / DevOps", "Frontend", "BI / Analyse", "Autres"],
}

MODE_CATEGORY_LIMITS = {
    "dev": {"Frontend": 6, "Data": 4, "IA": 3, "BI / Analyse": 2},
    "data": {"Frontend": 0, "Backend": 4, "IA": 4, "BI / Analyse": 4},
    "ai": {"Frontend": 0, "BI / Analyse": 3, "Backend": 4},
    "hybrid": {"Frontend": 4, "BI / Analyse": 3},
}


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-ZÀ-ÿ0-9+#.]{2,}", text.lower())


def extract_keywords(job_offer: str, limit: int = 18) -> list[str]:
    tokens = [token for token in tokenize(job_offer) if token not in STOPWORDS]
    counts = Counter(tokens)
    boosted = Counter()

    for token, count in counts.items():
        boost = 4 if token in KNOWN_TECHS else 1
        boosted[token] = count * boost

    return [word for word, _ in boosted.most_common(limit)]


def score_text(text: str, keywords: list[str]) -> int:
    searchable = " ".join(tokenize(text))
    return sum(1 for keyword in keywords if keyword.lower() in searchable)


def rank_items(items: list[ProfileItem], keywords: list[str], max_items: int) -> list[ProfileItem]:
    ranked = sorted(
        items,
        key=lambda item: score_text(
            f"{item.title} {item.organization} {item.description} {item.tags}",
            keywords,
        ),
        reverse=True,
    )
    return [item for item in ranked[:max_items] if item.title or item.description]


def split_lines(value: str) -> list[str]:
    return [line.strip(" -") for line in value.splitlines() if line.strip(" -")]


def select_skills(skills: str, keywords: list[str]) -> list[str]:
    raw = re.split(r"[,;\n]", skills)
    normalized = [skill.strip() for skill in raw if skill.strip()]
    matching = [
        skill for skill in normalized
        if any(keyword.lower() in skill.lower() for keyword in keywords)
    ]
    remaining = [skill for skill in normalized if skill not in matching]
    return (matching + remaining)[:24]


def categorize_skills(skills: list[str]) -> dict[str, list[str]]:
    categories: dict[str, list[str]] = {name: [] for name in SKILL_CATEGORIES}
    categories["Autres"] = []

    for skill in skills:
        skill_key = skill.lower().strip()
        selected_category = "Autres"

        for category, aliases in SKILL_CATEGORIES.items():
            if any(alias in skill_key for alias in aliases):
                selected_category = category
                break

        categories[selected_category].append(skill)

    return {category: values for category, values in categories.items() if values}


def infer_mode(keywords: list[str]) -> str:
    text = " ".join(keywords)
    if any(word in text for word in ["airflow", "spark", "etl", "elt", "dbt"]):
        return "data"
    if any(word in text for word in ["llm", "rag", "mlops", "pytorch", "tensorflow"]):
        return "ai"
    if any(word in text for word in ["react", "node", "api", "fastapi", "django"]):
        return "dev"
    return "hybrid"


def resolve_mode(profile_mode: str, keywords: list[str]) -> str:
    if profile_mode in {"dev", "data", "ai", "hybrid"}:
        return profile_mode
    return infer_mode(keywords)


def infer_title(profile: Profile, keywords: list[str], mode: str) -> str:
    if profile.target_title.strip():
        return profile.target_title.strip()

    text = " ".join(keywords)
    if mode == "data":
        return "Data Engineer"
    if mode == "ai":
        return "AI Engineer"
    if mode == "dev":
        return "Full Stack Developer"
    if mode == "hybrid" and any(word in text for word in ["airflow", "spark", "etl", "elt", "dbt"]):
        return "Full Stack / Data Engineer"
    if mode == "hybrid" and any(word in text for word in ["llm", "rag", "mlops", "pytorch", "tensorflow"]):
        return "Full Stack / AI Engineer"
    if any(word in text for word in ["pandas", "tableau", "powerbi", "analyse"]):
        return "Data Analyst / Data Scientist"
    return profile.target_title or "Software Engineer"


def order_skill_groups(skill_groups: dict[str, list[str]], mode: str) -> dict[str, list[str]]:
    priority = MODE_CATEGORY_PRIORITY.get(mode, MODE_CATEGORY_PRIORITY["hybrid"])
    limits = MODE_CATEGORY_LIMITS.get(mode, {})
    ordered: dict[str, list[str]] = {}

    for category in priority:
        values = skill_groups.get(category, [])
        limit = limits.get(category)
        if limit == 0:
            continue
        if limit:
            values = values[:limit]
        if values:
            ordered[category] = values

    return ordered


def split_skills(value: str) -> list[str]:
    return [skill.strip() for skill in re.split(r"[,;\n]", value) if skill.strip()]


def build_manual_skill_groups(profile: Profile, keywords: list[str]) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {}

    for group in profile.skill_groups:
        if not group.include or not group.name.strip():
            continue

        skills = split_skills(group.skills)
        if not skills:
            continue

        matching = [
            skill for skill in skills
            if any(keyword.lower() in skill.lower() for keyword in keywords)
        ]
        remaining = [skill for skill in skills if skill not in matching]
        groups[group.name.strip()] = (matching + remaining)[:12]

    return groups


def build_cv_html(profile: Profile, job_offer: str, keywords: list[str], profile_mode: str) -> str:
    mode = resolve_mode(profile_mode, keywords)
    title = infer_title(profile, keywords, mode)
    experiences = rank_items(profile.experiences, keywords, 4)

    summary = profile.summary.strip()
    if not summary:
        summary = (
            f"Profil {title} orienté conception, livraison et amélioration de solutions "
            "techniques adaptées aux enjeux produit, data et IA."
        )

    contacts = " | ".join(
        part for part in [profile.location, profile.email, profile.phone, profile.links] if part
    )

    def render_item(item: ProfileItem) -> str:
        bullets = split_lines(item.description)
        bullet_html = "".join(f"<li>{escape(bullet)}</li>" for bullet in bullets[:5])
        meta = " - ".join(part for part in [item.organization, item.period] if part)
        return (
            "<article class='cv-item'>"
            f"<div class='item-head'><h3>{escape(item.title)}</h3><span>{escape(meta)}</span></div>"
            f"<ul>{bullet_html}</ul>"
            "</article>"
        )

    skill_groups = build_manual_skill_groups(profile, keywords)
    if not skill_groups:
        skills = select_skills(profile.skills, keywords)
        skill_groups = order_skill_groups(categorize_skills(skills), mode)

    skills_html = "".join(
        f"<p class='skill-group'><strong>{escape(category)} :</strong> "
        f"{' · '.join(escape(skill) for skill in values)}</p>"
        for category, values in skill_groups.items()
    )
    experience_html = "".join(render_item(item) for item in experiences)
    education_items = profile.education_items or [
        ProfileItem(title=line) for line in split_lines(profile.education)
    ]
    education_html = "".join(
        render_item(item)
        for item in education_items
        if item.include and (item.title or item.description)
    )
    language_html = "".join(f"<li>{escape(line)}</li>" for line in split_lines(profile.languages))
    return f"""
<section class="cv-page" contenteditable="true">
  <header class="cv-header">
    <h1>{escape(profile.name or "Votre nom")}</h1>
    <h2>{escape(title)}</h2>
    <p>{escape(contacts)}</p>
  </header>

  <section>
    <h2>Profil</h2>
    <p>{escape(summary)}</p>
  </section>

  <section>
    <h2>Compétences</h2>
    <div class="skill-list">{skills_html}</div>
  </section>

  <section>
    <h2>Expérience professionnelle</h2>
    {experience_html or "<p>Ajoutez vos expériences dans la palette de profil.</p>"}
  </section>

  <section>
    <h2>Formation</h2>
    {education_html or "<p>Ajoutez vos formations dans la palette de profil.</p>"}
  </section>

  <section>
    <h2>Langues</h2>
    <ul>{language_html}</ul>
  </section>
</section>
"""


def ask_ollama(profile: Profile, job_offer: str, draft_html: str) -> tuple[str, bool, str]:
    prompt = f"""
Tu es un assistant CV ATS. Améliore le CV HTML ci-dessous pour l'offre donnée.
Contraintes:
- garde un HTML simple
- ne mens pas
- ne crée pas d'expérience inexistante
- garde les titres de sections ATS classiques
- réponds uniquement avec le HTML de la section CV

OFFRE:
{job_offer}

PROFIL SOURCE:
{profile.model_dump_json(indent=2)}

CV HTML:
{draft_html}
"""
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
    }).encode("utf-8")
    request = Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=45) as response:
            data = json.loads(response.read().decode("utf-8"))
            html = data.get("response", "").strip()
            if "<section" in html and "</section>" in html:
                return html, True, ""
            return draft_html, False, "Ollama a répondu, mais le HTML n'était pas exploitable."
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        return draft_html, False, f"Ollama indisponible: {error}"


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    with open(BASE_DIR / "static" / "index.html", encoding="utf-8") as file:
        return file.read()


@app.get("/api/draft/{draft_id}")
def get_draft(draft_id: str) -> dict:
    return load_draft_payload(draft_id) or {"payload": None, "updated_at": None}


@app.post("/api/draft/{draft_id}")
def save_draft(draft_id: str, draft: DraftPayload) -> dict:
    save_draft_payload(draft_id, draft.payload)
    return {"saved": True}


@app.delete("/api/draft/{draft_id}")
def delete_draft(draft_id: str) -> dict:
    delete_draft_payload(draft_id)
    return {"deleted": True}


@app.get("/api/profiles")
def list_profiles() -> dict:
    return {"profiles": list_profiles_payloads()}


@app.post("/api/profiles")
def create_profile(profile: ProfilePayload) -> dict:
    return create_profile_payload(profile)


@app.get("/api/profiles/{profile_id}")
def get_profile(profile_id: str) -> dict:
    profile = load_profile_payload(profile_id)
    return {"profile": profile}


@app.put("/api/profiles/{profile_id}")
def update_profile(profile_id: str, profile: ProfilePayload) -> dict:
    return update_profile_payload(profile_id, profile)


@app.delete("/api/profiles/{profile_id}")
def delete_profile(profile_id: str) -> dict:
    delete_profile_payload(profile_id)
    return {"deleted": True}


@app.get("/api/cv-drafts")
def list_cv_drafts() -> dict:
    return {"drafts": list_cv_drafts_payloads()}


@app.post("/api/cv-drafts/analyze")
def analyze_offer(payload: JobOfferPayload) -> dict:
    return analyze_offer_payload(payload)


@app.get("/api/cv-drafts/{draft_id}")
def get_cv_draft(draft_id: str) -> dict:
    return {"draft": load_cv_draft_payload(draft_id)}


@app.put("/api/cv-drafts/{draft_id}")
def update_cv_draft(draft_id: str, draft: CvDraftPayload) -> dict:
    return update_cv_draft_payload(draft_id, draft)


@app.delete("/api/cv-drafts/{draft_id}")
def delete_cv_draft(draft_id: str) -> dict:
    delete_cv_draft_payload(draft_id)
    return {"deleted": True}


@app.post("/api/generate", response_model=GenerateResponse)
def generate_cv(payload: GenerateRequest) -> GenerateResponse:
    keywords = extract_keywords(payload.job_offer)
    draft_html = build_cv_html(payload.profile, payload.job_offer, keywords, payload.profile_mode)
    html = draft_html
    used_ollama = False
    note = ""

    if payload.use_ollama:
        html, used_ollama, note = ask_ollama(payload.profile, payload.job_offer, draft_html)

    profile_text = payload.profile.model_dump_json()
    match_score = min(100, int((score_text(profile_text, keywords) / max(len(keywords), 1)) * 100))
    return GenerateResponse(
        html=html,
        keywords=keywords,
        match_score=match_score,
        used_ollama=used_ollama,
        note=note,
    )
