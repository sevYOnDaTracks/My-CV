from __future__ import annotations

import json
import re
import sqlite3
import webbrowser
from collections import Counter
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from threading import Timer
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
    summary_alignment: str = "left"
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


class AccountPayload(BaseModel):
    first_name: str = ""
    last_name: str = ""
    email: str = ""
    phone: str = ""
    address: str = ""
    location: str = ""
    links: str = ""


class ResumePayload(BaseModel):
    title: str = "CV sans titre"
    status: str = "draft"
    template_id: str = ""
    payload: dict = Field(default_factory=dict)
    generated_html: str = ""


class TemplatePayload(BaseModel):
    name: str = "Modèle sans nom"
    description: str = ""
    payload: dict = Field(default_factory=dict)
    generated_html: str = ""


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
            CREATE TABLE IF NOT EXISTS account (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS resumes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                template_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                generated_html TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS resume_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                payload TEXT NOT NULL,
                generated_html TEXT NOT NULL,
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
        connection.execute(
            """
            INSERT OR IGNORE INTO resumes
                (id, title, status, template_id, payload, generated_html, created_at, updated_at)
            SELECT id, title, 'draft', '', payload, generated_html, created_at, updated_at
            FROM cv_drafts
            WHERE NOT EXISTS (SELECT 1 FROM app_meta WHERE key = 'legacy_cv_migrated')
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('legacy_cv_migrated', '1')"
        )
        connection.execute(
            """
            INSERT OR IGNORE INTO resumes
                (id, title, status, template_id, payload, generated_html, created_at, updated_at)
            SELECT 'legacy-draft-' || id, 'Brouillon récupéré', 'draft', '', payload, '', updated_at, updated_at
            FROM drafts
            WHERE NOT EXISTS (SELECT 1 FROM app_meta WHERE key = 'legacy_draft_migrated')
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('legacy_draft_migrated', '1')"
        )


def get_account_payload() -> dict | None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute("SELECT payload, updated_at FROM account WHERE id = 1").fetchone()
    if not row:
        return None
    return {"payload": json.loads(row[0]), "updated_at": row[1]}


def save_account_payload(account: AccountPayload) -> dict:
    init_database()
    now = datetime.now(timezone.utc).isoformat()
    payload = account.model_dump()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            INSERT INTO account (id, payload, updated_at) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
            """,
            (json.dumps(payload, ensure_ascii=False), now),
        )
    return {"payload": payload, "updated_at": now}


def list_resumes_payloads() -> list[dict]:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        rows = connection.execute(
            "SELECT id, title, status, template_id, updated_at FROM resumes ORDER BY updated_at DESC"
        ).fetchall()
    return [
        {"id": row[0], "title": row[1], "status": row[2], "template_id": row[3], "updated_at": row[4]}
        for row in rows
    ]


def load_resume_payload(resume_id: str) -> dict | None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            "SELECT id, title, status, template_id, payload, generated_html, updated_at FROM resumes WHERE id = ?",
            (resume_id,),
        ).fetchone()
    if not row:
        return None
    return {"id": row[0], "title": row[1], "status": row[2], "template_id": row[3],
            "payload": json.loads(row[4]), "generated_html": row[5], "updated_at": row[6]}


def save_resume_payload(resume: ResumePayload, resume_id: str | None = None) -> dict:
    init_database()
    now = datetime.now(timezone.utc).isoformat()
    resume_id = resume_id or uuid4().hex
    status = resume.status if resume.status in {"draft", "final"} else "draft"
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """
            INSERT INTO resumes (id, title, status, template_id, payload, generated_html, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
                template_id = excluded.template_id, payload = excluded.payload,
                generated_html = excluded.generated_html, updated_at = excluded.updated_at
            """,
            (resume_id, resume.title.strip() or "CV sans titre", status, resume.template_id,
             json.dumps(resume.payload, ensure_ascii=False), resume.generated_html, now, now),
        )
    return load_resume_payload(resume_id) or {"id": resume_id}


def delete_resume_payload(resume_id: str) -> None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("DELETE FROM resumes WHERE id = ?", (resume_id,))


def list_templates_payloads() -> list[dict]:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        rows = connection.execute(
            "SELECT id, name, description, updated_at FROM resume_templates ORDER BY updated_at DESC"
        ).fetchall()
    return [{"id": row[0], "name": row[1], "description": row[2], "updated_at": row[3]} for row in rows]


def load_template_payload(template_id: str) -> dict | None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        row = connection.execute(
            "SELECT id, name, description, payload, generated_html, updated_at FROM resume_templates WHERE id = ?",
            (template_id,),
        ).fetchone()
    if not row:
        return None
    return {"id": row[0], "name": row[1], "description": row[2], "payload": json.loads(row[3]),
            "generated_html": row[4], "updated_at": row[5]}


def save_template_payload(template: TemplatePayload) -> dict:
    init_database()
    template_id = uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute(
            """INSERT INTO resume_templates
               (id, name, description, payload, generated_html, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (template_id, template.name.strip() or "Modèle sans nom", template.description,
             json.dumps(template.payload, ensure_ascii=False), template.generated_html, now, now),
        )
    return load_template_payload(template_id) or {"id": template_id}


def delete_template_payload(template_id: str) -> None:
    init_database()
    with sqlite3.connect(DATABASE_PATH) as connection:
        connection.execute("DELETE FROM resume_templates WHERE id = ?", (template_id,))


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


def rank_items(items: list[ProfileItem], keywords: list[str]) -> list[ProfileItem]:
    ranked = sorted(
        items,
        key=lambda item: score_text(
            f"{item.title} {item.organization} {item.description} {item.tags}",
            keywords,
        ),
        reverse=True,
    )
    return [item for item in ranked if item.include and (item.title or item.description)]


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
    return "Titre professionnel"


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
    experiences = rank_items(profile.experiences, keywords)

    summary = profile.summary.strip()
    if not summary:
        summary = "Ajoutez une présentation professionnelle concise et orientée résultats."
    summary_alignment = profile.summary_alignment if profile.summary_alignment in {"left", "justify", "center"} else "left"

    contacts = " | ".join(
        part for part in [profile.location, profile.email, profile.phone, profile.links] if part
    )

    def render_item(item: ProfileItem) -> str:
        bullets = split_lines(item.description)
        bullet_html = "".join(f"<li>{escape(bullet)}</li>" for bullet in bullets)
        meta = " · ".join(part for part in [item.organization, item.period] if part)
        return (
            "<article class='cv-item'>"
            f"<div class='item-head'><h3>{escape(item.title)}</h3>"
            f"{f'<span class=\"item-meta\">{escape(meta)}</span>' if meta else ''}</div>"
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
<section class="cv-page">
  <header class="cv-header">
    <h1>{escape(profile.name or "Votre nom")}</h1>
    <h2>{escape(title)}</h2>
    <p>{escape(contacts)}</p>
  </header>

  <section>
    <h2>Profil</h2>
    <p class="cv-summary align-{summary_alignment}">{escape(summary)}</p>
  </section>

  <section>
    <h2>Compétences</h2>
    <div class="skill-list">{skills_html}</div>
  </section>

  <section>
    <h2>Expérience professionnelle</h2>
    {experience_html or "<p>Ajoutez vos expériences professionnelles.</p>"}
  </section>

  <section>
    <h2>Formation</h2>
    {education_html or "<p>Ajoutez vos formations.</p>"}
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


@app.get("/api/account")
def get_account() -> dict:
    return {"account": get_account_payload()}


@app.put("/api/account")
def save_account(account: AccountPayload) -> dict:
    return {"account": save_account_payload(account)}


@app.get("/api/resumes")
def list_resumes() -> dict:
    return {"resumes": list_resumes_payloads()}


@app.post("/api/resumes")
def create_resume(resume: ResumePayload) -> dict:
    return {"resume": save_resume_payload(resume)}


@app.get("/api/resumes/{resume_id}")
def get_resume(resume_id: str) -> dict:
    return {"resume": load_resume_payload(resume_id)}


@app.put("/api/resumes/{resume_id}")
def update_resume(resume_id: str, resume: ResumePayload) -> dict:
    return {"resume": save_resume_payload(resume, resume_id)}


@app.delete("/api/resumes/{resume_id}")
def delete_resume(resume_id: str) -> dict:
    delete_resume_payload(resume_id)
    return {"deleted": True}


@app.get("/api/templates")
def list_templates() -> dict:
    return {"templates": list_templates_payloads()}


@app.post("/api/templates")
def create_template(template: TemplatePayload) -> dict:
    return {"template": save_template_payload(template)}


@app.get("/api/templates/{template_id}")
def get_template(template_id: str) -> dict:
    return {"template": load_template_payload(template_id)}


@app.delete("/api/templates/{template_id}")
def delete_template(template_id: str) -> dict:
    delete_template_payload(template_id)
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


def run_local_app() -> None:
    import uvicorn

    url = "http://127.0.0.1:8000"
    Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    run_local_app()
