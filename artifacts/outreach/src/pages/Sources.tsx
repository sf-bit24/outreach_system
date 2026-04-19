import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, Database, FileText, AlertCircle, CheckCircle2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getListLeadsQueryKey } from "@workspace/api-client-react";

interface SourcesStatus {
  apollo: { configured: boolean };
  csv: { configured: boolean };
}

interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

const CSV_EXAMPLE = `first_name,last_name,email,company,job_title,website,location,industry
Marie,Tremblay,marie@cabinetlegal.ca,Cabinet Legal Inc,Avocate associée,https://cabinetlegal.ca,Montréal,Juridique
Pierre,Gagnon,pierre@compta-qc.ca,Comptables QC,CPA Senior,https://compta-qc.ca,Québec,Comptabilité`;

export default function Sources() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<SourcesStatus | null>(null);
  const [csvText, setCsvText] = useState("");
  const [importing, setImporting] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);

  // Apollo search state
  const [apolloKeywords, setApolloKeywords] = useState("");
  const [apolloTitles, setApolloTitles] = useState("");
  const [apolloLocations, setApolloLocations] = useState("Quebec, Canada");
  const [apolloSearching, setApolloSearching] = useState(false);
  const [apolloError, setApolloError] = useState<string | null>(null);
  const [apolloResults, setApolloResults] = useState<any[]>([]);

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}api/sources`)
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ apollo: { configured: false }, csv: { configured: true } }));
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
      toast({
        title: "Import terminé",
        description: `${data.imported} importés, ${data.skipped} ignorés.`,
      });
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

  async function handleApolloSearch() {
    setApolloSearching(true);
    setApolloError(null);
    setApolloResults([]);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sources/apollo/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: apolloKeywords || undefined,
          jobTitles: apolloTitles ? apolloTitles.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          locations: apolloLocations ? apolloLocations.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          perPage: 25,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Recherche échouée");
      setApolloResults(data.people ?? []);
    } catch (err) {
      setApolloError(err instanceof Error ? err.message : "Recherche échouée");
    } finally {
      setApolloSearching(false);
    }
  }

  async function handleApolloImportAll() {
    if (apolloResults.length === 0) return;
    setImporting(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/sources/apollo/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ people: apolloResults }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Import échoué");
      qc.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      toast({
        title: "Import Apollo terminé",
        description: `${data.imported} importés, ${data.skipped} ignorés (emails verrouillés ou doublons).`,
      });
      setApolloResults([]);
    } catch (err) {
      toast({
        title: "Erreur",
        description: err instanceof Error ? err.message : "Import échoué",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Sources de leads</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Importez des leads depuis un fichier CSV ou via Apollo.io.
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
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileUpload}
              className="hidden"
            />
            <Label
              htmlFor="csv-file"
              className="inline-flex items-center gap-2 px-3 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium cursor-pointer hover:bg-secondary/80"
            >
              <Upload className="w-4 h-4" /> Choisir un fichier
            </Label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCsvText(CSV_EXAMPLE)}
              type="button"
            >
              Charger un exemple
            </Button>
          </div>

          <Textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={CSV_EXAMPLE}
            rows={10}
            className="font-mono text-xs"
          />

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Champs requis : prénom, nom, email, entreprise, poste.
            </p>
            <Button onClick={handleCsvImport} disabled={importing || !csvText.trim()}>
              {importing ? "Import en cours…" : "Importer"}
            </Button>
          </div>

          {lastResult && (
            <div className="mt-4 p-4 bg-muted/50 rounded-md text-sm">
              <div className="flex items-center gap-2 font-medium mb-2">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                {lastResult.imported} leads importés, {lastResult.skipped} ignorés
              </div>
              {lastResult.errors.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Voir les {lastResult.errors.length} erreurs
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground max-h-48 overflow-auto">
                    {lastResult.errors.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Apollo */}
      <section className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
            <Database className="w-5 h-5 text-indigo-600" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Apollo.io</h2>
            <p className="text-sm text-muted-foreground">
              Recherche directe dans la base Apollo. {status?.apollo.configured ? (
                <span className="text-green-600">Clé API configurée.</span>
              ) : (
                <span className="text-amber-600">Clé API manquante.</span>
              )}
            </p>
          </div>
        </div>

        <div className="rounded-md bg-amber-50 border border-amber-200 p-3 mb-4 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-amber-900">
            <strong>Plan gratuit Apollo :</strong> les endpoints Search et People Match sont
            verrouillés. Si vous obtenez une erreur 403, exportez votre liste depuis l'interface
            web d'Apollo (Search → Export to CSV) puis utilisez l'import CSV ci-dessus.
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div>
            <Label className="text-xs">Mots-clés</Label>
            <Input
              value={apolloKeywords}
              onChange={(e) => setApolloKeywords(e.target.value)}
              placeholder="cabinet comptable"
            />
          </div>
          <div>
            <Label className="text-xs">Titres (séparés par virgule)</Label>
            <Input
              value={apolloTitles}
              onChange={(e) => setApolloTitles(e.target.value)}
              placeholder="CEO, Founder, CPA"
            />
          </div>
          <div>
            <Label className="text-xs">Localisations (séparées par virgule)</Label>
            <Input
              value={apolloLocations}
              onChange={(e) => setApolloLocations(e.target.value)}
              placeholder="Quebec, Canada"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={handleApolloSearch}
            disabled={apolloSearching || !status?.apollo.configured}
            variant="outline"
          >
            <Search className="w-4 h-4 mr-2" />
            {apolloSearching ? "Recherche…" : "Rechercher"}
          </Button>
          {apolloResults.length > 0 && (
            <Button onClick={handleApolloImportAll} disabled={importing}>
              Importer les {apolloResults.length} résultats
            </Button>
          )}
        </div>

        {apolloError && (
          <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
            {apolloError}
          </div>
        )}

        {apolloResults.length > 0 && (
          <div className="mt-4 border border-border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Nom</th>
                  <th className="px-3 py-2 text-left font-medium">Poste</th>
                  <th className="px-3 py-2 text-left font-medium">Entreprise</th>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                </tr>
              </thead>
              <tbody>
                {apolloResults.map((p, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-2">{p.firstName} {p.lastName}</td>
                    <td className="px-3 py-2 text-muted-foreground">{p.jobTitle}</td>
                    <td className="px-3 py-2">{p.company}</td>
                    <td className="px-3 py-2 text-xs">
                      {p.email ?? <span className="text-amber-600">verrouillé</span>}
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
