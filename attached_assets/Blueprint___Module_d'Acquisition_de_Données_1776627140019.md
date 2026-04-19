# Blueprint : Module d'Acquisition de Données

Ce document décrit le fonctionnement du module d'acquisition de données, responsable de la collecte initiale des informations sur les entreprises et les contacts à partir de sources publiques et open source. L'accent est mis sur la conformité légale (LCAP) et l'éthique.

## 1. Objectif

Collecter des données structurées sur les entreprises et leurs décideurs (ICP) à partir de sources publiques, en respectant les principes de la Loi C-28 (LCAP) concernant la "publication bien en vue" des adresses email.

## 2. Sources de Données

Le module interagira avec les sources suivantes :

### 2.1. Registre des Entreprises du Québec (REQ) via Données Québec

*   **Description :** Le portail [Données Québec](https://www.donneesquebec.ca/recherche/dataset/registre-des-entreprises) fournit un fichier ZIP bimensuel du Registre des Entreprises du Québec. Ce fichier contient des informations légales sur les entreprises (raison sociale, adresse, NEQ, etc.), mais exclut les informations personnelles des individus.
*   **Données Extraites :** Nom de l'entreprise, adresse physique, secteur d'activité (si disponible), NEQ.
*   **Outil Open Source Recommandé :** Le projet GitHub `quebec/req` [1] peut servir de base pour la lecture et l'interprétation des données du REQ. Un script Python personnalisé sera nécessaire pour décompresser le fichier ZIP et parser les données (CSV ou autre format).
*   **Considérations LCAP :** Les adresses email ne sont pas directement disponibles ici. Cette source sert principalement à identifier les entreprises cibles.

### 2.2. Google Maps (Scraping Localisé)

*   **Description :** Google Maps est une source riche pour identifier des entreprises par catégorie et localisation géographique, particulièrement utile pour les services locaux.
*   **Données Extraites :** Nom de l'entreprise, adresse, numéro de téléphone, URL du site web (si disponible), catégorie d'entreprise.
*   **Outils Open Source Recommandés :**
    *   `gosom/google-maps-scraper` [2] : Un scraper puissant et gratuit, disponible en CLI ou via une interface web.
    *   `zohaibbashir/Google-Maps-Scrapper` [3] : Un script Python basé sur Playwright pour l'extraction de données.
*   **Considérations LCAP :** Le scraping des URLs de sites web est la première étape. L'extraction des emails à partir de ces sites devra être effectuée par le module d'enrichissement, en vérifiant la "publication bien en vue".

### 2.3. Apollo.io et LinkedIn (Scraping Ciblée)

*   **Description :** Ces plateformes sont des sources primaires pour identifier les décideurs (ICP) et leurs coordonnées professionnelles. L'objectif est de contourner les limites d'exportation d'Apollo.io et d'extraire des profils LinkedIn publics.
*   **Données Extraites :** Nom du contact, titre de poste, nom de l'entreprise, URL du profil LinkedIn, et potentiellement l'adresse email professionnelle (si publiée de manière visible).
*   **Outils Open Source Recommandés :**
    *   **Pour Apollo.io :** `scrapefulldotcom/apollo-scraper` [4], `FraneCal/apollo_scraper` [5], `liveupx/apollo-email-scraper` [6], `maximo3k/apollo-search-scraper` [7]. Ces outils visent à extraire des données sans API payante.
    *   **Pour LinkedIn :** `joeyism/linkedin_scraper` [8], `dchrastil/ScrapedIn` [9]. Ces projets permettent le scraping de profils publics.
*   **Considérations LCAP :** L'extraction d'adresses email doit être conditionnée par leur "publication bien en vue" sur le site web de l'entreprise ou le profil LinkedIn, sans mention d'exclusion. Le lien avec les fonctions professionnelles est crucial.

## 3. Flux de Travail du Module d'Acquisition

1.  **Définition des Cibles :** L'utilisateur définit les critères ICP (secteur, taille, localisation) pour chaque source.
2.  **Exécution des Scrapers :**
    *   Le scraper REQ télécharge et parse le fichier ZIP, stockant les entreprises dans `data/raw/req_companies.csv`.
    *   Le scraper Google Maps recherche les entreprises par catégorie/localisation et stocke les résultats (nom, adresse, URL) dans `data/raw/google_maps_companies.csv`.
    *   Les scrapers Apollo/LinkedIn ciblent les décideurs au sein des entreprises identifiées ou via des recherches directes, stockant les contacts (nom, titre, entreprise, URL LinkedIn, email si trouvé et conforme LCAP) dans `data/raw/contacts.csv`.
3.  **Déduplication et Fusion :** Les données brutes sont dédupliquées et fusionnées pour créer une liste unique d'entreprises et de contacts potentiels.

## 4. Architecture Technique (Exemple de Pseudo-code)

```python
# src/scrapers/req_scraper.py
def scrape_req_data(zip_file_path):
    # Logique pour décompresser et parser le fichier REQ
    # Retourne une liste de dictionnaires d'entreprises

# src/scrapers/google_maps_scraper.py
def scrape_google_maps(query, location):
    # Utilise un des repos GitHub mentionnés pour scraper Google Maps
    # Retourne une liste de dictionnaires d'entreprises avec URLs

# src/scrapers/linkedin_apollo_scraper.py
def scrape_linkedin_apollo(company_name, job_title_keywords):
    # Utilise un des repos GitHub mentionnés pour scraper LinkedIn/Apollo
    # Retourne une liste de dictionnaires de contacts (nom, email, titre, etc.)

# src/scrapers/main_acquisition.py
def run_acquisition_pipeline(icp_criteria):
    req_companies = scrape_req_data(...)
    google_maps_companies = scrape_google_maps(...)
    linkedin_contacts = scrape_linkedin_apollo(...)

    # Logique de déduplication et fusion
    # Sauvegarde dans data/raw/unified_leads.csv
    return unified_leads
```

## 5. Références

[1] `quebec/req`: Registre des entrepises du Québec Library for ... - GitHub. (n.d.). Retrieved from [https://github.com/quebec/req](https://github.com/quebec/req)
[2] `gosom/google-maps-scraper` - GitHub. [https://github.com/gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)
[3] `zohaibbashir/Google-Maps-Scrapper` - GitHub. [https://github.com/zohaibbashir/Google-Maps-Scrapper](https://github.com/zohaibbashir/Google-Maps-Scrapper)
[4] `scrapefulldotcom/apollo-scraper`: Get more leads from ... - GitHub. (n.d.). Retrieved from [https://github.com/scrapefulldotcom/apollo-scraper](https://github.com/scrapefulldotcom/apollo-scraper)
[5] `FraneCal/apollo_scraper` - GitHub. (n.d.). Retrieved from [https://github.com/FraneCal/apollo_scraper](https://github.com/FraneCal/apollo_scraper)
[6] `liveupx/apollo-email-scraper`: Apollo Free ... - GitHub. (n.d.). Retrieved from [https://github.com/liveupx/apollo-email-scraper](https://github.com/liveupx/apollo-email-scraper)
[7] `maximo3k/apollo-search-scraper`: Apollo.io search scraper with excel CSV export - GitHub. (n.d.). Retrieved from [https://github.com/maximo3k/apollo-search-scraper](https://github.com/maximo3k/apollo-search-scraper)
[8] `joeyism/linkedin_scraper`: A library that scrapes Linkedin for user data - GitHub. (n.d.). Retrieved from [https://github.com/joeyism/linkedin_scraper](https://github.com/joeyism/linkedin_scraper)
[9] `dchrastil/ScrapedIn`: A tool to scrape LinkedIn without API ... - GitHub. (n.d.). Retrieved from [https://github.com/dchrastil/ScrapedIn](https://github.com/dchrastil/ScrapedIn)
