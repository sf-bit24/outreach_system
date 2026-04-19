# Blueprint : Module d'Enrichissement et Validation

Ce document détaille le module d'enrichissement et de validation, qui prend les données brutes du module d'acquisition et les affine en ajoutant des informations contextuelles, en détectant des signaux d'intention et en validant les adresses email. L'objectif est de fournir des leads hautement qualifiés et conformes pour la personnalisation.

## 1. Objectif

Enrichir les profils de leads avec des informations pertinentes tirées des sites web des entreprises et des plateformes d'emploi, valider la délivrabilité des adresses email, et confirmer la conformité LCAP/RGPD pour l'envoi.

## 2. Fonctionnalités Clés

*   **Web Scraping Contextuel :** Extraction d'informations clés des sites web des entreprises (mission, valeurs, produits/services, actualités, blog).
*   **Détection de Signaux d'Intention :** Identification des entreprises en phase de croissance ou de changement via l'analyse des offres d'emploi.
*   **Validation d'Email :** Vérification de la syntaxe, du domaine et de l'existence de l'adresse email pour assurer une haute délivrabilité.
*   **Vérification LCAP/RGPD :** Confirmation que l'adresse email est "publiée bien en vue" et liée aux fonctions professionnelles du destinataire.

## 3. Sources de Données

*   **URLs des Sites Web des Entreprises :** Issues du module d'acquisition (Google Maps, REQ).
*   **Plateformes d'Offres d'Emploi :** LinkedIn Jobs, Indeed, Glassdoor, etc.
*   **Données de Contact Brutes :** Issues du module d'acquisition (Apollo, LinkedIn).

## 4. Outils Open Source Recommandés

### 4.1. Web Scraping Contextuel

*   **Pour l'extraction de contenu de sites web :**
    *   `BeautifulSoup` (Python) : Pour le parsing HTML et l'extraction de données structurées. Très efficace pour des sites statiques ou semi-dynamiques.
    *   `Playwright` (Python/Node.js) : Pour interagir avec des sites web dynamiques (JavaScript) et simuler un navigateur réel. Utile pour extraire des informations qui ne sont pas directement dans le HTML initial.
*   **Stratégie :** Utiliser `Playwright` pour naviguer et `BeautifulSoup` pour parser le contenu. Extraire des mots-clés, des descriptions de produits/services, des sections "À propos de nous", des actualités, etc.

### 4.2. Détection de Signaux d'Intention (Offres d'Emploi)

*   **Outil Open Source Recommandé :** `speedyapply/JobSpy` [1] : Une bibliothèque Python qui permet de scraper les offres d'emploi de plusieurs plateformes (LinkedIn, Indeed, etc.).
*   **Stratégie :** Pour chaque entreprise cible, interroger `JobSpy` avec le nom de l'entreprise pour voir si elle a des offres d'emploi actives, en particulier pour des postes commerciaux ou de développement.

### 4.3. Validation d'Email

*   **Pour la validation de syntaxe et de domaine :**
    *   `JoshData/python-email-validator` [2] : Une bibliothèque Python pour vérifier la validité syntaxique et la présence du domaine de l'adresse email.
    *   `BaseMax/EmailVerifier` [3] : Un script Python qui va plus loin en effectuant des vérifications DNS (MX records) et potentiellement SMTP pour confirmer l'existence du serveur de messagerie.
*   **Stratégie :** Combiner ces outils pour une validation robuste. Une vérification SMTP est cruciale pour minimiser les rebonds et protéger la réputation de l'expéditeur.

## 5. Flux de Travail du Module d'Enrichissement et Validation

1.  **Réception des Leads :** Le module reçoit une liste de leads (entreprises et contacts) du module d'acquisition, incluant les URLs des sites web et les emails potentiels.
2.  **Scraping du Site Web :** Pour chaque entreprise, le module scrape le site web pour extraire des informations contextuelles et des mots-clés pertinents.
3.  **Détection des Signaux :** Le module interroge les plateformes d'emploi pour détecter si l'entreprise recrute, en particulier pour des postes clés.
4.  **Validation d'Email :** Pour chaque adresse email, le module effectue une série de vérifications (syntaxe, domaine, MX, SMTP).
5.  **Vérification LCAP/RGPD :** Le module confirme que l'email est bien visible sur le site web de l'entreprise et qu'il n'y a pas de mention d'exclusion. Il vérifie également que le message sera lié aux fonctions professionnelles du destinataire.
6.  **Mise à Jour du Lead :** Les informations enrichies et le statut de validation de l'email sont ajoutés au profil du lead, qui est ensuite stocké dans `data/processed/enriched_leads.csv`.

## 6. Architecture Technique (Exemple de Pseudo-code)

```python
# src/enrichment/website_scraper.py
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

def scrape_website_content(url):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(url)
        html_content = page.content()
        browser.close()
    soup = BeautifulSoup(html_content, 'html.parser')
    # Logique d'extraction de texte, mots-clés, etc.
    return {"content": "...", "keywords": "..."}

# src/enrichment/job_board_detector.py
from speedyapply.JobSpy import JobSpy

def detect_job_postings(company_name):
    job_spy = JobSpy()
    jobs = job_spy.scrape(keywords=company_name, limit=5) # Limiter pour éviter les abus
    # Logique pour analyser les offres d'emploi et détecter les signaux
    return {"hiring_signal": True, "job_titles": ["VP Sales", "Marketing Manager"]}

# src/enrichment/email_validator.py
from email_validator import validate_email, EmailNotValidError
# from EmailVerifier import verify_email # Exemple pour BaseMax/EmailVerifier

def validate_and_check_lcap(email, company_website_url):
    try:
        v = validate_email(email, check_deliverability=False) # check_deliverability peut être coûteux ou lent
        # Effectuer des vérifications DNS (MX records) ici si nécessaire
        # Simuler une vérification SMTP (avec prudence pour ne pas être bloqué)

        # Vérification LCAP (simplifiée pour l'exemple)
        # Idéalement, cela nécessiterait de scraper la page où l'email a été trouvé
        is_publicly_visible = True # À implémenter avec un scraping ciblé
        no_opt_out_mention = True # À implémenter avec un scraping ciblé

        if is_publicly_visible and no_opt_out_mention:
            return {"status": "valid_lcap_compliant", "reason": "Email valide et conforme LCAP"}
        else:
            return {"status": "valid_lcap_non_compliant", "reason": "Email valide mais non conforme LCAP"}
    except EmailNotValidError as e:
        return {"status": "invalid", "reason": str(e)}

# src/enrichment/main_enrichment.py
def run_enrichment_pipeline(unified_leads):
    enriched_leads = []
    for lead in unified_leads:
        website_info = scrape_website_content(lead["company_website_url"])
        job_signals = detect_job_postings(lead["company_name"])
        email_validation_result = validate_and_check_lcap(lead["email"], lead["company_website_url"])

        lead.update(website_info)
        lead.update(job_signals)
        lead.update({"email_validation": email_validation_result})
        enriched_leads.append(lead)

    # Sauvegarde dans data/processed/enriched_leads.csv
    return enriched_leads
```

## 7. Références

[1] `speedyapply/JobSpy`: Jobs scraper library for LinkedIn ... - GitHub. (n.d.). Retrieved from [https://github.com/speedyapply/JobSpy](https://github.com/speedyapply/JobSpy)
[2] `JoshData/python-email-validator` - GitHub. (n.d.). Retrieved from [https://github.com/JoshData/python-email-validator](https://github.com/JoshData/python-email-validator)
[3] `BaseMax/EmailVerifier`: EmailVerifier is a Python script that allows you to verify email ... - GitHub. (n.d.). Retrieved from [https://github.com/BaseMax/EmailVerifier](https://github.com/BaseMax/EmailVerifier)
