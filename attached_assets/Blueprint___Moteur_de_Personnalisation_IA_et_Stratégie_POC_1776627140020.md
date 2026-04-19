# Blueprint : Moteur de Personnalisation IA et Stratégie POC

Ce document décrit le module central de personnalisation, qui utilise l'intelligence artificielle pour transformer les données enrichies en messages d'outreach uniques et percutants. L'objectif est de créer une connexion authentique avec le prospect en démontrant une compréhension approfondie de son contexte et en intégrant la stratégie de "Proof of Concept" (POC).

## 1. Objectif

Générer des messages d'outreach hautement personnalisés et contextuels, incluant des phrases d'accroche uniques basées sur des faits réels et une intégration dynamique de la stratégie de "preuve par l'exemple", afin d'augmenter les taux de réponse et de conversion.

## 2. Fonctionnalités Clés

*   **Analyse Sémantique Avancée :** Interpréter les informations collectées (site web, offres d'emploi, secteur d'activité) pour identifier les points de douleur, les opportunités et les centres d'intérêt du prospect.
*   **Génération de Phrases d'Accroche Uniques :** Créer des introductions personnalisées qui démontrent une recherche préalable et une compréhension du contexte du prospect.
*   **Intégration Dynamique de la Stratégie POC :** Insérer des éléments de preuve de l'efficacité du système d'outreach (votre propre succès) de manière fluide et convaincante.
*   **Adaptation du Ton et du Style :** Ajuster le langage et le ton du message en fonction du secteur d'activité et du rôle du prospect.
*   **Optimisation du Call-to-Action (CTA) :** Proposer des CTAs pertinents et clairs qui incitent à la prochaine étape (rendez-vous, démo).

## 3. Sources de Données

*   **Leads Enrichis :** Données provenant du module d'enrichissement (`data/processed/enriched_leads.csv`), incluant :
    *   Nom de l'entreprise, secteur, taille.
    *   Nom du contact, titre de poste.
    *   Informations clés du site web (mission, produits, actualités, mots-clés).
    *   Signaux d'intention (ex: offres d'emploi).
    *   Statut de validation de l'email et conformité LCAP.
*   **Templates de Messages :** Fichiers de configuration contenant des structures de messages, des exemples de CTAs et des variables pour la personnalisation.

## 4. Outils Open Source Recommandés

### 4.1. Large Language Models (LLMs) pour la Génération de Texte

Bien que l'API OpenAI soit mentionnée dans le `.env.example`, il existe des alternatives open source ou des frameworks pour l'orchestration qui peuvent être utilisés avec des modèles locaux ou d'autres fournisseurs.

*   **`ollama` [1] :** Permet de faire tourner des LLMs open source (comme Llama 3, Mistral, Gemma) localement sur votre machine. Idéal pour réduire les coûts et garder le contrôle des données. L'intégration se fait via une API locale compatible OpenAI.
*   **`langchain` [2] / `LlamaIndex` [3] :** Frameworks Python pour construire des applications avec des LLMs. Ils facilitent l'intégration avec divers modèles (y compris ceux via `ollama` ou d'autres API), la gestion des prompts, la chaîne de pensée (chaining) et la récupération d'informations (RAG - Retrieval Augmented Generation).
*   **`guidance` [4] :** Une bibliothèque Python de Microsoft qui permet de contrôler les LLMs avec une syntaxe de templating puissante, utile pour structurer les sorties et garantir la qualité des messages générés.

### 4.2. Prompt Engineering et Structuration des Messages

L'efficacité de l'IA dépendra fortement de la qualité des prompts.

*   **Stratégie :** Utiliser des prompts multi-étapes ou des chaînes de prompts pour guider le LLM. Par exemple :
    1.  **Prompt 1 (Analyse) :** "À partir de ces données sur l'entreprise X et le contact Y, identifie 3 points d'intérêt majeurs et 1 point de douleur potentiel."
    2.  **Prompt 2 (Accroche) :** "Rédige une phrase d'accroche de 20 mots maximum, mentionnant un des points d'intérêt identifiés, pour un email de prospection B2B."
    3.  **Prompt 3 (Intégration POC) :** "Intègre la phrase suivante : 'Notre approche a déjà permis d'obtenir des rendez-vous qualifiés pour des entreprises similaires, comme en témoigne notre propre succès à vous contacter.' de manière fluide dans le corps de l'email."

## 5. Flux de Travail du Moteur de Personnalisation

1.  **Sélection du Lead :** Le module reçoit un lead enrichi du pipeline, prêt pour la personnalisation.
2.  **Analyse des Données :** Le LLM (via `ollama` ou API OpenAI) analyse les informations du lead (site web, signaux d'emploi, titre de poste) pour comprendre le contexte.
3.  **Génération de l'Accroche :** Le LLM génère une phrase d'accroche unique, basée sur un élément spécifique trouvé dans les données du lead (ex: une actualité récente, un poste ouvert, un produit spécifique).
4.  **Rédaction du Corps du Message :** Le LLM rédige le corps de l'email, en intégrant les points de douleur/opportunités identifiés et en adaptant le ton.
5.  **Intégration POC :** La stratégie de "preuve par l'exemple" est insérée dynamiquement, expliquant comment le système a déjà prouvé son efficacité (ex: "C'est d'ailleurs grâce à une approche similaire que nous avons pu identifier votre entreprise et vous contacter aujourd'hui.").
6.  **Génération du CTA :** Un Call-to-Action clair et pertinent est généré, invitant à un rendez-vous ou à une démo.
7.  **Validation Humaine (Optionnel) :** Pour les premiers envois ou les leads à haute valeur, une révision humaine peut être intégrée pour affiner la personnalisation.
8.  **Output :** Le message finalisé est stocké dans `data/processed/personalized_messages.csv` ou directement transmis au module d'envoi.

## 6. Architecture Technique (Exemple de Pseudo-code)

```python
# src/ai_engine/personalization_engine.py
import os
from openai import OpenAI # Compatible avec ollama si l'API est configurée localement

class PersonalizationEngine:
    def __init__(self, api_key=None, base_url=None, model="gpt-4o-mini"):
        self.client = OpenAI(api_key=api_key or os.getenv("OPENAI_API_KEY"), base_url=base_url)
        self.model = model

    def generate_hook(self, lead_data):
        prompt = f"""En te basant sur les informations suivantes sur l'entreprise {lead_data['company_name']} et le contact {lead_data['contact_name']} ({lead_data['contact_title']}), rédige une phrase d'accroche courte (max 20 mots) pour un email de prospection B2B. Mets en avant un point d'intérêt spécifique ou une opportunité. Informations clés: {lead_data['website_keywords']}, {lead_data['hiring_signal']}.
        Accroche:"""
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.choices[0].message.content.strip()

    def generate_body_and_cta(self, lead_data, hook, poc_message):
        prompt = f"""Rédige le corps d'un email de prospection B2B pour {lead_data['contact_name']} chez {lead_data['company_name']}. Utilise l'accroche: '{hook}'.
        Intègre le message de preuve de concept: '{poc_message}'.
        Le message doit être concis, professionnel et proposer un appel à l'action clair pour un rendez-vous. Mentionne comment notre solution peut aider avec {lead_data['pain_point'] or 'leurs objectifs'}.
        Email:"""
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}]
        )
        return response.choices[0].message.content.strip()

    def personalize_message(self, lead_data):
        # Exemple de message POC dynamique
        poc_message = "C'est d'ailleurs grâce à une approche similaire que nous avons pu identifier votre entreprise et vous contacter aujourd'hui, démontrant l'efficacité de notre système."

        hook = self.generate_hook(lead_data)
        full_message = self.generate_body_and_cta(lead_data, hook, poc_message)
        return {"subject": f"Opportunité pour {lead_data['company_name']}", "body": full_message}

# src/ai_engine/main_ai_engine.py
def run_personalization_pipeline(enriched_leads):
    engine = PersonalizationEngine()
    personalized_messages = []
    for lead in enriched_leads:
        # Assurez-vous que lead_data contient toutes les infos nécessaires
        # Ex: lead['pain_point'] devrait être déduit de l'enrichissement
        personalized_msg = engine.personalize_message(lead)
        lead.update(personalized_msg)
        personalized_messages.append(lead)

    # Sauvegarde dans data/processed/personalized_messages.csv
    return personalized_messages
```

## 7. Références

[1] `ollama/ollama`: Get up and running with Llama 2, Mistral, Gemma, and other large language models. - GitHub. (n.d.). Retrieved from [https://github.com/ollama/ollama](https://github.com/ollama/ollama)
[2] `langchain-ai/langchain`: ⚡ Building applications with LLMs through composability ⚡ - GitHub. (n.d.). Retrieved from [https://github.com/langchain-ai/langchain](https://github.com/langchain-ai/langchain)
[3] `run-llama/llama_index`: LlamaIndex is a data framework for your LLM applications - GitHub. (n.d.). Retrieved from [https://github.com/run-llama/llama_index](https://github.com/run-llama/llama_index)
[4] `microsoft/guidance`: A guidance language for controlling large language models. - GitHub. (n.d.). Retrieved from [https://github.com/microsoft/guidance](https://github.com/microsoft/guidance)
