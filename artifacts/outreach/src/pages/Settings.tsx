import { useState, useEffect } from "react";
import { Settings as SettingsIcon, Mail, Server, Thermometer, CheckCircle2, XCircle, Loader2, Send, ShieldAlert, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SenderSettings {
  id: number;
  senderName: string;
  senderEmail: string;
  senderCompany: string;
  senderAddress: string;
  pocMessage: string;
  valueProposition: string;
  dailyLimit: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  resendEnabled: boolean;
  resendConfigured: boolean;
  transportMode: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpConfigured: boolean;
  warmupEnabled: boolean;
  warmupStartDate: string | null;
  warmupStartVolume: number;
  warmupIncrement: number;
  warmupMaxVolume: number;
  warmupEffectiveLimit: number;
  bounceDetectionEnabled: boolean;
  imapHost: string | null;
  imapPort: number;
  autoPipelineEnabled: boolean;
  autoAcquireCategories: string[];
  autoAcquireCities: string[];
  autoAcquireMaxPerRun: number;
  autoAssignCampaignId: number | null;
  lastAutoRunAt: string | null;
  lastAutoRunSummary: string | null;
  lastAutoAcquisitionAt: string | null;
  lastAutoAcquisitionSummary: string | null;
  updatedAt: string;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchSettings(): Promise<SenderSettings> {
  const r = await fetch(`${BASE}/api/settings/sender`);
  if (!r.ok) throw new Error("Impossible de charger les paramètres");
  return r.json();
}

async function patchSettings(body: Record<string, unknown>): Promise<SenderSettings> {
  const r = await fetch(`${BASE}/api/settings/sender`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error ?? r.statusText);
  }
  return r.json();
}

interface Campaign { id: number; name: string; }

async function fetchCampaigns(): Promise<Campaign[]> {
  const r = await fetch(`${BASE}/api/campaigns`);
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : (data.campaigns ?? []);
}

async function testSend(to?: string): Promise<{ success: boolean; message: string }> {
  const r = await fetch(`${BASE}/api/settings/sender/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(to ? { to } : {}),
  });
  return r.json();
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg p-6 space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold text-sm">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export default function Settings() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<SenderSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState("");

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  const [form, setForm] = useState({
    senderName: "",
    senderEmail: "",
    senderCompany: "",
    senderAddress: "",
    pocMessage: "",
    valueProposition: "",
    dailyLimit: 50,
    delayMinSeconds: 60,
    delayMaxSeconds: 180,
    transportMode: "simulation",
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    warmupEnabled: false,
    warmupStartDate: "",
    warmupStartVolume: 5,
    warmupIncrement: 5,
    warmupMaxVolume: 50,
    bounceDetectionEnabled: false,
    imapHost: "",
    imapPort: 993,
    autoPipelineEnabled: false,
    autoAcquireCategories: "",
    autoAcquireCities: "",
    autoAcquireMaxPerRun: 50,
    autoAssignCampaignId: "none",
  });

  useEffect(() => {
    Promise.all([fetchSettings(), fetchCampaigns()])
      .then(([s, c]) => {
        setCampaigns(c);
        setSettings(s);
        setForm({
          senderName: s.senderName,
          senderEmail: s.senderEmail,
          senderCompany: s.senderCompany,
          senderAddress: s.senderAddress,
          pocMessage: s.pocMessage,
          valueProposition: s.valueProposition,
          dailyLimit: s.dailyLimit,
          delayMinSeconds: s.delayMinSeconds,
          delayMaxSeconds: s.delayMaxSeconds,
          transportMode: s.transportMode,
          smtpHost: s.smtpHost ?? "",
          smtpPort: s.smtpPort ?? 587,
          smtpUser: s.smtpUser ?? "",
          smtpPass: "",
          warmupEnabled: s.warmupEnabled,
          warmupStartDate: s.warmupStartDate ? s.warmupStartDate.slice(0, 10) : "",
          warmupStartVolume: s.warmupStartVolume,
          warmupIncrement: s.warmupIncrement,
          warmupMaxVolume: s.warmupMaxVolume,
          bounceDetectionEnabled: s.bounceDetectionEnabled,
          imapHost: s.imapHost ?? "",
          imapPort: s.imapPort,
          autoPipelineEnabled: s.autoPipelineEnabled,
          autoAcquireCategories: s.autoAcquireCategories.join(", "),
          autoAcquireCities: s.autoAcquireCities.join(", "),
          autoAcquireMaxPerRun: s.autoAcquireMaxPerRun,
          autoAssignCampaignId: s.autoAssignCampaignId ? String(s.autoAssignCampaignId) : "none",
        });
      })
      .catch(() => toast({ title: "Erreur de chargement", variant: "destructive" }))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        senderName: form.senderName,
        senderEmail: form.senderEmail,
        senderCompany: form.senderCompany,
        senderAddress: form.senderAddress,
        pocMessage: form.pocMessage,
        valueProposition: form.valueProposition,
        dailyLimit: form.dailyLimit,
        delayMinSeconds: form.delayMinSeconds,
        delayMaxSeconds: form.delayMaxSeconds,
        transportMode: form.transportMode,
        smtpHost: form.smtpHost || undefined,
        smtpPort: form.smtpPort,
        smtpUser: form.smtpUser || undefined,
        warmupEnabled: form.warmupEnabled,
        warmupStartDate: form.warmupStartDate || undefined,
        warmupStartVolume: form.warmupStartVolume,
        warmupIncrement: form.warmupIncrement,
        warmupMaxVolume: form.warmupMaxVolume,
        bounceDetectionEnabled: form.bounceDetectionEnabled,
        imapHost: form.imapHost || undefined,
        imapPort: form.imapPort,
        autoPipelineEnabled: form.autoPipelineEnabled,
        autoAcquireCategories: form.autoAcquireCategories
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        autoAcquireCities: form.autoAcquireCities
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        autoAcquireMaxPerRun: form.autoAcquireMaxPerRun,
        autoAssignCampaignId:
          form.autoAssignCampaignId && form.autoAssignCampaignId !== "none"
            ? Number(form.autoAssignCampaignId)
            : null,
      };
      if (form.smtpPass) body.smtpPass = form.smtpPass;
      const updated = await patchSettings(body);
      setSettings(updated);
      setForm((f) => ({ ...f, smtpPass: "" }));
      toast({ title: "Paramètres sauvegardés" });
    } catch (err) {
      toast({ title: "Erreur de sauvegarde", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const result = await testSend(testTo || undefined);
      toast({
        title: result.success ? "Email de test envoyé ✓" : "Échec du test",
        description: result.message,
        variant: result.success ? "default" : "destructive",
      });
    } catch (err) {
      toast({ title: "Erreur réseau", description: (err as Error).message, variant: "destructive" });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const transportMode = form.transportMode;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <SettingsIcon className="w-6 h-6" />
          <h1 className="text-xl font-bold">Paramètres d'envoi</h1>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Sauvegarder
        </Button>
      </div>

      {/* ── Identité expéditeur ── */}
      <Section title="Identité LCAP (expéditeur)" icon={Mail}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Nom d'expéditeur">
            <Input value={form.senderName} onChange={(e) => set("senderName", e.target.value)} placeholder="Jean Tremblay" />
          </Field>
          <Field label="Email d'expéditeur">
            <Input value={form.senderEmail} onChange={(e) => set("senderEmail", e.target.value)} placeholder="jean@exemple.com" />
          </Field>
          <Field label="Entreprise">
            <Input value={form.senderCompany} onChange={(e) => set("senderCompany", e.target.value)} placeholder="ACME inc." />
          </Field>
          <Field label="Adresse physique (LCAP obligatoire)">
            <Input value={form.senderAddress} onChange={(e) => set("senderAddress", e.target.value)} placeholder="123 rue Sainte-Catherine, Montréal QC H3B 1A4" />
          </Field>
        </div>
        <Field label="Message point de contact (accroche personnalisée)">
          <Textarea rows={3} value={form.pocMessage} onChange={(e) => set("pocMessage", e.target.value)} />
        </Field>
        <Field label="Proposition de valeur">
          <Textarea rows={2} value={form.valueProposition} onChange={(e) => set("valueProposition", e.target.value)} placeholder="Nous aidons les PME québécoises à..." />
        </Field>
      </Section>

      {/* ── Transport ── */}
      <Section title="Transport d'envoi" icon={Server}>
        <Field label="Mode">
          <Select value={transportMode} onValueChange={(v) => set("transportMode", v)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="simulation">🧪 Simulation (aucun email réel)</SelectItem>
              <SelectItem value="smtp">📧 SMTP (votre propre boîte)</SelectItem>
              <SelectItem value="resend">⚡ Resend API</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {transportMode === "smtp" && (
          <>
            {settings && !settings.smtpConfigured && (
              <div className="flex items-start gap-2 rounded-md bg-red-50 border border-red-300 p-3 text-sm text-red-800">
                <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-600" />
                <div>
                  <p className="font-semibold">Mot de passe SMTP manquant — aucun email ne peut être envoyé</p>
                  <p className="text-xs text-red-700 mt-0.5">
                    Saisissez le mot de passe ci-dessous et cliquez sur Enregistrer pour débloquer l'envoi.
                  </p>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 mt-3 border border-dashed border-border rounded-md p-4">
              <Field label="Hôte SMTP">
                <Input value={form.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} placeholder="smtp.gmail.com" />
              </Field>
              <Field label="Port">
                <Input type="number" value={form.smtpPort} onChange={(e) => set("smtpPort", Number(e.target.value))} placeholder="587" />
              </Field>
              <Field label="Utilisateur">
                <Input value={form.smtpUser} onChange={(e) => set("smtpUser", e.target.value)} placeholder="votre@email.com" />
              </Field>
              <Field label={`Mot de passe${settings?.smtpConfigured ? " (● configuré)" : " ⚠ requis"}`}>
                <Input
                  type="password"
                  value={form.smtpPass}
                  onChange={(e) => set("smtpPass", e.target.value)}
                  placeholder={settings?.smtpConfigured ? "Laisser vide pour conserver" : "Mot de passe ou App Password"}
                  className={!settings?.smtpConfigured ? "border-red-400 focus-visible:ring-red-400" : ""}
                />
              </Field>
              <div className="col-span-2 text-xs text-muted-foreground">
                💡 Google Workspace / Gmail : utilisez un <strong>App Password</strong> (Sécurité → Mots de passe des applications). Zoho / M365 : credentials normaux ou mot de passe d'application.
              </div>
            </div>
          </>
        )}

        {transportMode === "resend" && (
          <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
            Resend configuré : {" "}
            {settings?.resendConfigured ? (
              <span className="text-green-600 font-medium">✓ Clé API présente</span>
            ) : (
              <span className="text-red-600 font-medium">✗ Clé API manquante (RESEND_API_KEY)</span>
            )}
          </div>
        )}

        {/* Test send */}
        <div className="flex items-center gap-3 pt-2 border-t border-border mt-2">
          <Input
            placeholder="Destinataire test (défaut : votre email)"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            className="max-w-xs"
          />
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Send className="w-4 h-4 mr-2" />}
            Envoyer test
          </Button>
        </div>
      </Section>

      {/* ── File d'attente ── */}
      <Section title="File d'attente" icon={SettingsIcon}>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Limite quotidienne">
            <Input type="number" min={1} value={form.dailyLimit} onChange={(e) => set("dailyLimit", Number(e.target.value))} />
          </Field>
          <Field label="Délai min (s)">
            <Input type="number" min={0} value={form.delayMinSeconds} onChange={(e) => set("delayMinSeconds", Number(e.target.value))} />
          </Field>
          <Field label="Délai max (s)">
            <Input type="number" min={0} value={form.delayMaxSeconds} onChange={(e) => set("delayMaxSeconds", Number(e.target.value))} />
          </Field>
        </div>
      </Section>

      {/* ── Warmup ── */}
      <Section title="Chauffe progressive (warmup)" icon={Thermometer}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Activer le warmup</p>
            <p className="text-xs text-muted-foreground">Augmente progressivement le volume quotidien pour établir la réputation de la boîte.</p>
          </div>
          <Switch checked={form.warmupEnabled} onCheckedChange={(v) => set("warmupEnabled", v)} />
        </div>

        {form.warmupEnabled && (
          <div className="grid grid-cols-2 gap-4 border border-dashed border-border rounded-md p-4">
            <Field label="Date de départ">
              <Input type="date" value={form.warmupStartDate} onChange={(e) => set("warmupStartDate", e.target.value)} />
            </Field>
            <Field label="Volume initial (J1)">
              <Input type="number" min={1} value={form.warmupStartVolume} onChange={(e) => set("warmupStartVolume", Number(e.target.value))} />
            </Field>
            <Field label="Incrément / jour">
              <Input type="number" min={1} value={form.warmupIncrement} onChange={(e) => set("warmupIncrement", Number(e.target.value))} />
            </Field>
            <Field label="Volume max warmup">
              <Input type="number" min={1} value={form.warmupMaxVolume} onChange={(e) => set("warmupMaxVolume", Number(e.target.value))} />
            </Field>
            {settings && (
              <div className="col-span-2 rounded-md bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
                <strong>Limite effective aujourd'hui :</strong>{" "}
                {settings.warmupEffectiveLimit} emails
                {" "}(cap absolu : {form.dailyLimit})
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ── Pipeline automatique nocturne ── */}
      <Section title="Pipeline automatique nocturne" icon={Bot}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Activer le pipeline automatique</p>
            <p className="text-xs text-muted-foreground">
              Chaque nuit : acquisition Google Maps (02h UTC) → enrichissement (03h) → assignation campagne (03h30).
              Aucune action manuelle requise.
            </p>
          </div>
          <Switch checked={form.autoPipelineEnabled} onCheckedChange={(v) => set("autoPipelineEnabled", v)} />
        </div>

        {form.autoPipelineEnabled && (
          <div className="space-y-4 border border-dashed border-border rounded-md p-4">
            <Field label="Catégories Google Maps (séparées par des virgules)">
              <Input
                value={form.autoAcquireCategories}
                onChange={(e) => set("autoAcquireCategories", e.target.value)}
                placeholder="restaurant, plombier, avocat, comptable"
              />
            </Field>
            <Field label="Villes (séparées par des virgules)">
              <Input
                value={form.autoAcquireCities}
                onChange={(e) => set("autoAcquireCities", e.target.value)}
                placeholder="Montréal, Québec, Laval, Longueuil"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Max leads / nuit">
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={form.autoAcquireMaxPerRun}
                  onChange={(e) => set("autoAcquireMaxPerRun", Number(e.target.value))}
                />
              </Field>
              <Field label="Campagne par défaut (auto-assign)">
                <Select
                  value={form.autoAssignCampaignId}
                  onValueChange={(v) => set("autoAssignCampaignId", v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Aucune campagne" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Aucune (assignation manuelle)</SelectItem>
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {settings?.lastAutoAcquisitionAt && (
              <div className="rounded-md bg-muted p-3 space-y-1 text-xs">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                  <span className="font-medium">Dernière acquisition :</span>
                  <span className="text-muted-foreground">
                    {new Date(settings.lastAutoAcquisitionAt).toLocaleString("fr-CA")}
                  </span>
                </div>
                {settings.lastAutoAcquisitionSummary && (
                  <p className="text-muted-foreground pl-5">{settings.lastAutoAcquisitionSummary}</p>
                )}
              </div>
            )}
            {!settings?.lastAutoAcquisitionAt && (
              <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900">
                Prochain démarrage : <strong>02h00 UTC</strong> — acquisition de{" "}
                {form.autoAcquireCategories.split(",").filter(Boolean).length || "?"} catégorie(s) ×{" "}
                {form.autoAcquireCities.split(",").filter(Boolean).length || "?"} ville(s), max{" "}
                {form.autoAcquireMaxPerRun} leads.
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ── Détection des bounces IMAP ── */}
      <Section title="Détection des bounces IMAP" icon={ShieldAlert}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Activer la détection automatique</p>
            <p className="text-xs text-muted-foreground">
              Interroge la boîte IMAP du compte expéditeur toutes les 15 min pour détecter
              les DSN (bounces) et marquer les leads concernés comme non-joignables.
            </p>
          </div>
          <Switch
            checked={form.bounceDetectionEnabled}
            onCheckedChange={(v) => set("bounceDetectionEnabled", v)}
            disabled={form.transportMode !== "smtp"}
          />
        </div>

        {form.transportMode !== "smtp" && (
          <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            La détection des bounces nécessite le mode de transport SMTP.
          </p>
        )}

        {form.bounceDetectionEnabled && form.transportMode === "smtp" && (
          <div className="grid grid-cols-2 gap-4 border border-dashed border-border rounded-md p-4">
            <Field label="Hôte IMAP (optionnel)">
              <Input
                placeholder={form.smtpHost ? form.smtpHost.replace(/^smtp\./i, "imap.") : "imap.example.com"}
                value={form.imapHost}
                onChange={(e) => set("imapHost", e.target.value)}
              />
            </Field>
            <Field label="Port IMAP">
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.imapPort}
                onChange={(e) => set("imapPort", Number(e.target.value))}
              />
            </Field>
            <div className="col-span-2 rounded-md bg-blue-50 border border-blue-200 p-3 text-xs text-blue-900">
              Si l'hôte IMAP est vide, il est dérivé automatiquement depuis l'hôte SMTP
              (ex : <code>smtp.hostinger.com</code> → <code>imap.hostinger.com</code>).
              Les credentials (utilisateur + mot de passe) réutilisent ceux du compte SMTP.
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
