# CV Studio

Application locale de création et de gestion de CV avec aperçu A4 en temps réel.

## Fonctionnalités

- Un compte local pour conserver les coordonnées réutilisées sur chaque CV
- Plusieurs CV indépendants, enregistrés comme brouillons ou versions finalisées
- Modèles de départ et modèles personnels créés depuis un CV
- Aperçu A4 instantané pendant la saisie
- Choix du thème et de la police
- Adaptation facultative du contenu à une offre d'emploi
- Export PDF par l'impression du navigateur et export HTML autonome
- Sauvegarde automatique dans SQLite

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

Le compte, les CV, leur statut et les modèles personnels sont sauvegardés dans
`data/generator_cv.db`. Une sauvegarde automatique est déclenchée pendant l'édition
d'un CV déjà enregistré. Le raccourci `Ctrl+S` permet aussi de forcer l'enregistrement.

Au premier lancement de cette version, les anciens brouillons de candidature sont
automatiquement importés dans « Mes CV ». Les anciennes tables sont conservées.

Le fichier SQLite contient des données personnelles et est ignoré par Git via `.gitignore`.

## Export

- **PDF** ouvre la boîte d'impression du navigateur avec uniquement les pages du CV.
- **HTML** télécharge une version autonome contenant le style et le contenu du CV.
