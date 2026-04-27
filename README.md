# Générator CV

Application locale pour générer un CV adapté à une offre à partir d'une palette complète de profil.

## Lancer l'application

Si `python --version` ouvre le Microsoft Store ou ne répond pas, installer Python depuis <https://www.python.org/downloads/> puis relancer un terminal.

Sur Windows, évite le Python installé via Microsoft Store pour ce projet. Il peut créer un venv incomplet ou inaccessible. Si `.venv` a été créé pendant une tentative ratée, supprime-le puis recrée-le après installation d'un Python classique.

```powershell
Remove-Item -Recurse -Force .venv
```

1. Créer un environnement virtuel Python.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

2. Installer les dépendances :

```powershell
pip install -r requirements.txt
```

3. Lancer le serveur :

```powershell
uvicorn app.main:app --reload
```

4. Ouvrir :

```text
http://127.0.0.1:8000
```

## Ollama

Ollama est optionnel pour cette V1. Si Ollama tourne sur `http://localhost:11434`, l'application peut demander une reformulation plus naturelle du CV.

Le modèle par défaut est configurable dans `app/main.py`.

## Sauvegarde locale

L'application sauvegarde le brouillon à deux endroits :

- `localStorage` du navigateur pour une restauration rapide.
- SQLite côté backend dans `data/generator_cv.db`.

SQLite contient aussi les profils personnalisés :

- Profil Data
- Profil IA
- Profil Dev
- Profil Hybride
- Profils libres créés depuis l'accueil

Chaque profil garde sa palette, son mode, son thème, sa police et ses préférences.

L'accueil contient aussi un workflow candidature :

- Coller une offre
- Créer un brouillon CV à partir du profil le plus adapté
- Ouvrir/modifier ce brouillon
- Exporter en PDF
- Supprimer le brouillon si besoin

Pour l'instant, le choix du profil se fait avec un scoring local. Ollama sera branché ensuite pour analyser l'offre plus finement et proposer une adaptation plus intelligente.

Le fichier SQLite contient des données personnelles et est ignoré par Git via `.gitignore`.

## Objectif V1

- Saisir une palette complète de profil
- Coller une offre d'emploi
- Extraire les mots-clés importants
- Prioriser les expériences, projets et compétences pertinentes
- Générer un CV ATS simple
- Modifier le résultat dans l'interface
- Exporter en PDF via l'impression navigateur
