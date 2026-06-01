import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  Database,
  FileText,
  AlertCircle,
  CheckCircle2,
  Search,
  Linkedin,
  Cookie,
  Loader2,
  RefreshCw,
  Globe,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getListLeadsQueryKey } from "@workspace/api-client-react";

interface ScraperStatus {
  configured: boolean;
  status?: "active" | "expired" | "absent";
  lastError?: string | null;
}

interface SourcesStatus {
  apollo: { configured: boolean };
  csv: { configured: boolean };
  apolloScraper: ScraperStatus;
  linkedinScraper: ScraperStatus;
}

function CredentialBanner({ scraper }: { scraper: ScraperStatus | undefined }) {
  if (!scraper || scraper.status !== "expired") return null;
  return (
    <div className="rounded-md bg-red-50 border border-red-200 p-3 mb-3 flex items-start gap-2">
      <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
      <div className="text-xs text-red-900">
        <strong>Cookies expirés.</strong> Reconnectez-vous au service, exportez à nouveau vos
        cookies et ré-importez-les ci-dessous pour relancer les scrapings.
        {scraper.lastError && (
          <div className="mt-1 font-mono text-[10px] opacity-70">{scraper.lastError}</div>
        )}
      </div>
    </div>
  );
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

interface ScraperJob {
  id: number;
  provider: "apollo" | "linkedin";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  itemsScraped: number;
  itemsImported: number;
  itemsSkipped: number;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  params: Record<string, unknown>;
}

interface UsageInfo {
  apollo: { used: number; limit: number };
  linkedin: { used: number; limit: number };
  windowMinutes: number;
}

const CSV_EXAMPLE = `first_name,last_name,email,company,job_title,website,location,industry
Marie,Tremblay,marie@cabinetlegal.ca,Cabinet Legal Inc,Avocate associée,https://cabinetlegal.ca,Montréal,Juridique
Pierre,Gagnon,pierre@compta-qc.ca,Comptables QC,CPA Senior,https://compta-qc.ca,Québec,Comptabilité`;

export default function Sources() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SourcesStatus | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [jobs, setJobs] = useState<ScraperJob[]>([]);
  const [csvText, setCsvText] = useState("");
  const [importing, setImporting] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);

  // ASFC import
  const [asfcImporting, setAsfcImporting] = useState(false);
  const [asfcResult, setAsfcResult] = useState<(ImportResult & { total?: number }) | null>(null);

  // Scraper credential forms
  const [apolloCookies, setApolloCookies] = useState("");
  const [linkedinCookies, setLinkedinCookies] = useState("");

  // Scraper job forms
  const [apolloScrapeKw, setApolloScrapeKw] = useState("");
  const [apolloScrapeTitles, setApolloScrapeTitles] = useState("");
  const [apolloScrapeLocations, setApolloScrapeLocations] = useState("Quebec, Canada");
  const [apolloScrapeMaxPages, setApolloScrapeMaxPages] = useState(1);

  const [liScrapeKw, setLiScrapeKw] = useState("");
  const [liScrapeTitles, setLiScrapeTitles] = useState("");
  const [liScrapeLocations, setLiScrapeLocations] = useState("");
  const [liScrapeMax, setLiScrapeMax] = useState(25);

  function refreshAll() {
    fetch(`${import.meta.env.BASE_URL}api/sources`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => null);
    fetch(`${import.meta.env.BASE_URL}api/sources/scraper/usage`)
      .then((r) => r.json())
      .then(setUsage)
      .catch(() => null);
    fetch(`${import.meta.env.BASE_URL}api/sources/scraper/jobs`)
      .then((r) => r.json())
      .then(setJobs)
      .catch(() => null);
  }

  useEffect(() => {
    refreshAll();
    const interval = setInterval(() => {
      // Auto-refresh jobs while any are running/queued
      fetch(`${import.meta.env.BASE_URL}api/sources/scraper/jobs`)
        .then((r) => r.json())
        .then((js: ScraperJob[]) => {
          setJobs(js);
          if (js.some((j) => j.status === "running" || j.status === "queued")) {
            fetch(`${import.meta.env.BASE_URL}api/sources/scraper/usage`)
              .then((r) => r.json())
              .then(setUsage);
          }
        })
        .catch(() => null);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  async function handleCsvImport() {
    if (!csvText.trim()) {
      toast({ title: "CSV vide", description: "Collez ou téléversez un fichier CSV.", variant: "destructive" });
      return;
    }
    setImporting(true);
    setLastResult(null);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sources/csv/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Échec d'import");
      setLastResult(data);
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      toast({ title: "Import terminé", description: `${data.imported} importés, ${data.skipped} ignorés.` });
    } catch (err) {
      toast({
        title: "Erreur d'import",
        description: err instanceof Error ? err.message : "Erreur inconnue",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
  }

  async function handleAsfcImport() {
    setAsfcImporting(true);
    setAsfcResult(null);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sources/asfc/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Échec de l'import ASFC");
      setAsfcResult(data);
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      toast({
        title: "Import ASFC terminé",
        description: `${data.imported} courtiers importés, ${data.skipped} ignorés.`,
      });
    } catch (err) {
      toast({
        title: "Erreur ASFC",
        description: err instanceof Error ? err.message : "Erreur inconnue",
        variant: "destructive",
      });
    } finally {
      setAsfcImporting(false);
    }
  }

  async function saveCookies(provider: "apollo" | "linkedin", raw: string) {
    if (!raw.trim()) {
      toast({ title: "Cookies requis", variant: "destructive" });
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sources/scraper/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, cookies: raw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Échec");
      toast({ title: `Cookies ${provider} enregistrés (chiffrés)` });
      if (provider === "apollo") setApolloCookies("");
      else setLinkedinCookies("");
      refreshAll();
    } catch (err) {
      toast({
        title: "Erreur",
        description: err instanceof Error ? err.message : "Erreur",
        variant: "destructive",
      });
    }
  }

  async function clearCookies(provider: "apollo" | "linkedin") {
    await fetch(`${import.meta.env.BASE_URL}api/sources/scraper/credentials/${provider}`, {
      method: "DELETE",
    });
    toast({ title: `Cookies ${provider} supprimés` });
    refreshAll();
  }

  async function startApolloScrape() {
    const body = {
      provider: "apollo",
      keywords: apolloScrapeKw || undefined,
      jobTitles: apolloScrapeTitles
        ? apolloScrapeTitles.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      locations: apolloScrapeLocations
        ? apolloScrapeLocations.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      maxPages: apolloScrapeMaxPages,
    };
    const res = await fetch(`${import.meta.env.BASE_URL}api/sources/scraper/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: "Erreur", description: data?.error ?? "Échec", variant: "destructive" });
      return;
    }
    toast({ title: `Job Apollo #${data.id} en file d'attente` });
    refreshAll();
  }

  async function startLinkedInScrape() {
    const body = {
      provider: "linkedin",
      keywords: liScrapeKw || undefined,
      jobTitles: liScrapeTitles
        ? liScrapeTitles.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      locations: liScrapeLocations
        ? liScrapeLocations.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
      maxResults: liScrapeMax,
    };
    const res = await fetch(`${import.meta.env.BASE_URL}api/sources/scraper/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: "Erreur", description: data?.error ?? "Échec", variant: "destructive" });
      return;
    }
    toast({ title: `Job LinkedIn #${data.id} en file d'attente` });
    refreshAll();
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sources de leads</h1>
        <p className="text-sm text-muted-foreground mt-1">
          CSV, Apollo (API + scraping), et LinkedIn. Tous les emails douteux sont marqués
          <code className="mx-1 text-xs bg-muted px-1.5 py-0.5 rounded">needs_enrichment</code>
          et ne seront jamais envoyés sans vérification.
        </p>
      </div>

      {/* CSV Import */}
      <section className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Import CSV</h2>
            <p className="text-sm text-muted-foreground">
              Téléversez un fichier .csv ou collez son contenu. En-têtes acceptés (FR/EN) :
              <code className="ml-1 text-xs bg-muted px-1.5 py-0.5 rounded">first_name, last_name, email, company, job_title, website, location, industry, phone, linkedin_url</code>.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <input id="csv-file" type="file" accept=".csv,text/csv" onChange={handleFileUpload} className="hidden" />
            <Label
              htmlFor="csv-file"
              className="inline-flex items-center gap-2 px-3 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium cursor-pointer hover:bg-secondary/80"
            >
              <Upload className="w-4 h-4" /> Choisir un fichier
            </Label>
            <Button variant="outline" size="sm" onClick={() => setCsvText(CSV_EXAMPLE)} type="button">
              Charger un exemple
            </Button>
          </div>
          <Textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={CSV_EXAMPLE}
            rows={8}
            className="font-mono text-xs"
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Champs requis : prénom, nom, email, entreprise, poste.</p>
            <Button onClick={handleCsvImport} disabled={importing || !csvText.trim()}>
              {importing ? "Import en cours…" : "Importer"}
            </Button>
          </div>
          {lastResult && (
            <div className="mt-2 p-3 bg-muted/50 rounded-md text-sm">
              <div className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                {lastResult.imported} leads importés, {lastResult.skipped} ignorés
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Apollo Scraper */}
      <section className="bg-card border border-border rounded-lg p-6 mb-6">
        <CredentialBanner scraper={status?.apolloScraper} />
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
            <Database className="w-5 h-5 text-indigo-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Scraper Apollo (session navigateur)</h2>
            <p className="text-sm text-muted-foreground">
              Contourne les limites du plan gratuit en réutilisant votre session connectée.
              {status?.apolloScraper.status === "expired" ? (
                <span className="text-red-600 ml-1">Cookies expirés — reconnectez-vous.</span>
              ) : status?.apolloScraper.configured ? (
                <span className="text-green-600 ml-1">Cookies actifs.</span>
              ) : (
                <span className="text-amber-600 ml-1">Cookies manquants.</span>
              )}
              {usage && (
                <span className="ml-2 text-xs">
                  Quota : {usage.apollo.used}/{usage.apollo.limit} / heure
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 mb-4 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-900">
            <strong>Emails verrouillés Apollo :</strong> les emails non révélés sont marqués
            <code className="mx-1 bg-white/60 px-1 rounded">email_locked</code> et ne sont
            <strong> jamais envoyés</strong>. Vous devez les révéler dans Apollo (crédits)
            ou les vérifier via une autre source avant tout envoi.
          </div>
        </div>

        {!status?.apolloScraper.configured ? (
          <div className="space-y-2 mb-4">
            <Label className="text-xs flex items-center gap-1">
              <Cookie className="w-3 h-3" /> Cookies de session (JSON depuis EditThisCookie, ou en-tête Cookie:)
            </Label>
            <Textarea
              value={apolloCookies}
              onChange={(e) => setApolloCookies(e.target.value)}
              rows={5}
              className="font-mono text-xs"
              placeholder='[{"name":"_apollo_session","value":"...","domain":".apollo.io"}, ...]'
            />
            <Button size="sm" onClick={() => saveCookies("apollo", apolloCookies)}>
              Enregistrer (chiffré)
            </Button>
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 text-xs">
            <CheckCircle2 className="w-4 h-4 text-green-600" />
            Session Apollo active.
            <Button variant="ghost" size="sm" onClick={() => clearCookies("apollo")}>
              Supprimer
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
          <div>
            <Label className="text-xs">Mots-clés</Label>
            <Input value={apolloScrapeKw} onChange={(e) => setApolloScrapeKw(e.target.value)} placeholder="cabinet comptable" />
          </div>
          <div>
            <Label className="text-xs">Titres</Label>
            <Input value={apolloScrapeTitles} onChange={(e) => setApolloScrapeTitles(e.target.value)} placeholder="CEO, Founder" />
          </div>
          <div>
            <Label className="text-xs">Localisations</Label>
            <Input value={apolloScrapeLocations} onChange={(e) => setApolloScrapeLocations(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Pages max (1-5)</Label>
            <Input
              type="number"
              min={1}
              max={5}
              value={apolloScrapeMaxPages}
              onChange={(e) => setApolloScrapeMaxPages(Number(e.target.value) || 1)}
            />
          </div>
        </div>

        <Button
          onClick={startApolloScrape}
          disabled={status?.apolloScraper.status !== "active"}
          variant="outline"
        >
          <Search className="w-4 h-4 mr-2" />
          Lancer le scraping Apollo
        </Button>
      </section>

      {/* LinkedIn Scraper */}
      <section className="bg-card border border-border rounded-lg p-6 mb-6">
        <CredentialBanner scraper={status?.linkedinScraper} />
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-sky-50 flex items-center justify-center flex-shrink-0">
            <Linkedin className="w-5 h-5 text-sky-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Scraper LinkedIn (session navigateur)</h2>
            <p className="text-sm text-muted-foreground">
              Identifie les décideurs depuis la recherche LinkedIn People.
              {status?.linkedinScraper.status === "expired" ? (
                <span className="text-red-600 ml-1">Cookies expirés — reconnectez-vous.</span>
              ) : status?.linkedinScraper.configured ? (
                <span className="text-green-600 ml-1">Cookies actifs.</span>
              ) : (
                <span className="text-amber-600 ml-1">Cookies manquants.</span>
              )}
              {usage && (
                <span className="ml-2 text-xs">
                  Quota : {usage.linkedin.used}/{usage.linkedin.limit} / heure
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="rounded-md bg-red-50 border border-red-200 p-3 mb-4 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-red-900">
            <strong>LinkedIn ne fournit jamais d'email.</strong> Tous les leads importés ici
            sont marqués <code className="mx-1 bg-white/60 px-1 rounded">needs_enrichment</code>
            et bloqués pour l'envoi tant qu'un vrai email n'a pas été trouvé via le module
            d'enrichissement (site web, base publique). Aucun email n'est jamais deviné.
          </div>
        </div>

        {!status?.linkedinScraper.configured ? (
          <div className="space-y-2 mb-4">
            <Label className="text-xs flex items-center gap-1">
              <Cookie className="w-3 h-3" /> Cookies LinkedIn (doit contenir <code>li_at</code>)
            </Label>
            <Textarea
              value={linkedinCookies}
              onChange={(e) => setLinkedinCookies(e.target.value)}
              rows={5}
              className="font-mono text-xs"
              placeholder='[{"name":"li_at","value":"...","domain":".linkedin.com"}, ...]'
            />
            <Button size="sm" onClick={() => saveCookies("linkedin", linkedinCookies)}>
              Enregistrer (chiffré)
            </Button>
          </div>
        ) : (
          <div className="mb-4 flex items-center gap-2 text-xs">
            <CheckCircle2 className="w-4 h-4 text-green-600" />
            Session LinkedIn active.
            <Button variant="ghost" size="sm" onClick={() => clearCookies("linkedin")}>
              Supprimer
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-3">
          <div>
            <Label className="text-xs">Mots-clés</Label>
            <Input value={liScrapeKw} onChange={(e) => setLiScrapeKw(e.target.value)} placeholder="comptable Montréal" />
          </div>
          <div>
            <Label className="text-xs">Titres</Label>
            <Input value={liScrapeTitles} onChange={(e) => setLiScrapeTitles(e.target.value)} placeholder="CPA, Associé" />
          </div>
          <div>
            <Label className="text-xs">Localisations (geoUrn)</Label>
            <Input value={liScrapeLocations} onChange={(e) => setLiScrapeLocations(e.target.value)} placeholder="101174742" />
          </div>
          <div>
            <Label className="text-xs">Résultats max (1-100)</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={liScrapeMax}
              onChange={(e) => setLiScrapeMax(Number(e.target.value) || 25)}
            />
          </div>
        </div>

        <Button
          onClick={startLinkedInScrape}
          disabled={status?.linkedinScraper.status !== "active"}
          variant="outline"
        >
          <Search className="w-4 h-4 mr-2" />
          Lancer le scraping LinkedIn
        </Button>
      </section>

      {/* ASFC — Courtiers en douane agréés */}
      <section className="bg-card border border-border rounded-lg p-6 mb-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
            <Globe className="w-5 h-5 text-emerald-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">ASFC — Courtiers en douane agréés (Canada)</h2>
            <p className="text-sm text-muted-foreground">
              Liste officielle du gouvernement canadien (~416 entreprises, ~380 emails publiés). Mise à jour régulière.
              Source : <code className="text-xs bg-muted px-1 rounded">cbsa-asfc.gc.ca</code>
            </p>
          </div>
        </div>

        <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 mb-4 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-emerald-900">
            <strong>Emails gouvernementaux publiés.</strong> Ces adresses sont publiées officiellement par l'ASFC — elles restent
            marquées <code className="mx-1 bg-white/60 px-1 rounded">scraped</code> et bloquées jusqu'à vérification
            via enrichissement avant tout envoi.
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Button onClick={handleAsfcImport} disabled={asfcImporting} variant="outline">
            {asfcImporting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Import en cours…
              </>
            ) : (
              <>
                <Globe className="w-4 h-4 mr-2" />
                Importer depuis l'ASFC
              </>
            )}
          </Button>
          {asfcResult && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="w-4 h-4 text-green-600" />
              <span>
                <strong className="text-foreground">{asfcResult.imported}</strong> importés
                {asfcResult.total != null && ` sur ${asfcResult.total} trouvés`}
                {asfcResult.skipped > 0 && `, ${asfcResult.skipped} ignorés`}
              </span>
            </div>
          )}
        </div>
        {asfcResult && asfcResult.errors.length > 0 && (
          <div className="mt-3 p-2 bg-muted/50 rounded text-xs font-mono space-y-0.5">
            {asfcResult.errors.map((e, i) => (
              <div key={i} className="text-red-700">{e}</div>
            ))}
          </div>
        )}
      </section>

      {/* Jobs Feed */}
      <section className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Jobs de scraping récents</h2>
          <Button variant="ghost" size="sm" onClick={refreshAll}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucun job pour l'instant.</p>
        ) : (
          <div className="border border-border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Provider</th>
                  <th className="px-3 py-2 text-left font-medium">Statut</th>
                  <th className="px-3 py-2 text-left font-medium">Scrapés</th>
                  <th className="px-3 py-2 text-left font-medium">Importés</th>
                  <th className="px-3 py-2 text-left font-medium">Ignorés</th>
                  <th className="px-3 py-2 text-left font-medium">Détails</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{j.id}</td>
                    <td className="px-3 py-2">{j.provider}</td>
                    <td className="px-3 py-2">
                      {j.status === "running" || j.status === "queued" ? (
                        <span className="inline-flex items-center gap-1 text-xs text-blue-700">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          {j.status}
                        </span>
                      ) : j.status === "completed" ? (
                        <span className="inline-flex items-center gap-1 text-xs text-green-700">
                          <CheckCircle2 className="w-3 h-3" /> {j.status}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-red-700">
                          <AlertCircle className="w-3 h-3" /> {j.status}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs">{j.itemsScraped}</td>
                    <td className="px-3 py-2 text-xs text-green-700">{j.itemsImported}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{j.itemsSkipped}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
                      {j.errorMessage ?? JSON.stringify(j.params)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
