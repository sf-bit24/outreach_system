import { useParams, Link } from "wouter";
import { useState, useEffect } from "react";
import {
  useGetCampaign,
  useListLeads,
  useListEmails,
  useStartCampaign,
  usePauseCampaign,
  useUpdateCampaign,
  getGetCampaignQueryKey,
  getListLeadsQueryKey,
  getListEmailsQueryKey,
  getListCampaignsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Play, Pause, Mail, Users, Plus, Trash2,
  ChevronDown, ChevronUp, Clock, CheckCircle2, MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import StageBadge from "@/components/StageBadge";
import { EmailStatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/hooks/use-toast";

interface SequenceStep {
  delayDays: number;
  subject: string;
  body: string;
}

export default function CampaignDetail() {
  const { id } = useParams<{ id: string }>();
  const campaignId = parseInt(id, 10);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: campaign, isLoading } = useGetCampaign(campaignId, {
    query: {
      enabled: !!campaignId,
      queryKey: getGetCampaignQueryKey(campaignId),
    },
  });

  const { data: leads } = useListLeads(
    { campaignId },
    { query: { queryKey: getListLeadsQueryKey({ campaignId }) } },
  );

  const { data: emails } = useListEmails(
    { campaignId },
    { query: { queryKey: getListEmailsQueryKey({ campaignId }) } },
  );

  const startCampaign = useStartCampaign();
  const pauseCampaign = usePauseCampaign();
  const updateCampaign = useUpdateCampaign();

  // Sequence steps editor state
  const [steps, setSteps] = useState<SequenceStep[]>([]);
  const [sequenceOpen, setSequenceOpen] = useState(false);
  const [markingReplied, setMarkingReplied] = useState<number | null>(null);

  useEffect(() => {
    if (campaign?.sequenceSteps) {
      setSteps(campaign.sequenceSteps as SequenceStep[]);
    }
  }, [campaign?.sequenceSteps]);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(campaignId) });
    queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListEmailsQueryKey({ campaignId }) });
  }

  function handleStart() {
    startCampaign.mutate(
      { id: campaignId },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Campagne démarrée" });
        },
      },
    );
  }

  function handlePause() {
    pauseCampaign.mutate(
      { id: campaignId },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Campagne mise en pause" });
        },
      },
    );
  }

  function saveSequence() {
    updateCampaign.mutate(
      { id: campaignId, data: { sequenceSteps: steps } },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Séquence sauvegardée", description: `${steps.length} relance(s) configurée(s).` });
        },
        onError: () => {
          toast({ title: "Erreur", description: "Impossible de sauvegarder la séquence.", variant: "destructive" });
        },
      },
    );
  }

  function addStep() {
    setSteps((s) => [...s, { delayDays: 3, subject: "", body: "" }]);
  }

  function removeStep(i: number) {
    setSteps((s) => s.filter((_, idx) => idx !== i));
  }

  function updateStep(i: number, field: keyof SequenceStep, value: string | number) {
    setSteps((s) =>
      s.map((step, idx) =>
        idx === i ? { ...step, [field]: value } : step,
      ),
    );
  }

  async function markReplied(emailId: number) {
    setMarkingReplied(emailId);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/emails/${emailId}/mark-replied`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("Échec");
      const data = await res.json();
      refresh();
      toast({
        title: "Réponse enregistrée",
        description: `${data.cancelledFollowUps} relance(s) annulée(s).`,
      });
    } catch {
      toast({ title: "Erreur", variant: "destructive" });
    } finally {
      setMarkingReplied(null);
    }
  }

  if (isLoading) return <div className="p-8 text-slate-500">Chargement…</div>;
  if (!campaign) return <div className="p-8 text-slate-500">Campagne introuvable</div>;

  const initialEmails = emails?.filter((e) => e.sequenceStepIndex == null || e.sequenceStepIndex === 0) ?? [];
  const followUpEmails = emails?.filter((e) => (e.sequenceStepIndex ?? 0) > 0) ?? [];

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <Link href="/campaigns">
        <div className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 mb-4 cursor-pointer">
          <ArrowLeft className="w-4 h-4" /> Retour aux campagnes
        </div>
      </Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-900">{campaign.name}</h1>
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
              {campaign.status}
            </span>
          </div>
          {campaign.description && (
            <p className="text-sm text-slate-500 mt-1">{campaign.description}</p>
          )}
        </div>
        <div className="flex gap-2">
          {campaign.status === "active" ? (
            <Button variant="outline" onClick={handlePause}>
              <Pause className="w-4 h-4 mr-2" /> Pause
            </Button>
          ) : campaign.status !== "completed" ? (
            <Button onClick={handleStart}>
              <Play className="w-4 h-4 mr-2" /> Démarrer
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-8">
        <Stat label="Leads totaux" value={campaign.totalLeads} />
        <Stat label="Contactés" value={campaign.contacted} />
        <Stat label="Réponses" value={campaign.replied} accent="text-emerald-600" />
        <Stat
          label="Limite / délai"
          value={`${campaign.dailyLimit}/jour · ${campaign.sendingDelayMinutes}m`}
          small
        />
      </div>

      {/* Sequence editor */}
      <div className="bg-white border border-slate-200 rounded-lg mb-6 overflow-hidden">
        <button
          className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-slate-50 transition-colors"
          onClick={() => setSequenceOpen((o) => !o)}
        >
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-500" />
            <span className="font-semibold text-slate-900">
              Séquence de relances
            </span>
            <span className="text-xs text-slate-500 ml-1">
              ({steps.length} étape{steps.length !== 1 ? "s" : ""} configurée{steps.length !== 1 ? "s" : ""})
            </span>
          </div>
          {sequenceOpen ? (
            <ChevronUp className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </button>

        {sequenceOpen && (
          <div className="px-5 pb-5 border-t border-slate-100">
            <p className="text-xs text-slate-500 mt-3 mb-4">
              Les relances sont envoyées automatiquement après chaque envoi réussi.
              Elles sont annulées dès qu'une réponse est détectée.
            </p>

            {steps.length === 0 && (
              <div className="text-sm text-slate-400 text-center py-4">
                Aucune relance configurée — envoi unique seulement.
              </div>
            )}

            <div className="space-y-4">
              {steps.map((step, i) => (
                <div key={i} className="border border-slate-200 rounded-lg p-4 relative">
                  <div className="absolute -top-2.5 left-3 bg-white px-2 text-xs font-medium text-slate-600">
                    Relance {i + 1}
                  </div>
                  <button
                    className="absolute top-2 right-2 text-slate-300 hover:text-red-500 transition-colors"
                    onClick={() => removeStep(i)}
                    title="Supprimer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  <div className="grid grid-cols-3 gap-3 mt-1">
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Délai (jours)</label>
                      <input
                        type="number"
                        min={1}
                        value={step.delayDays}
                        onChange={(e) => updateStep(i, "delayDays", Math.max(1, parseInt(e.target.value, 10) || 1))}
                        className="w-full h-8 px-2 text-sm border border-border rounded-md bg-background"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-muted-foreground block mb-1">Objet de la relance</label>
                      <input
                        type="text"
                        value={step.subject}
                        onChange={(e) => updateStep(i, "subject", e.target.value)}
                        placeholder="Ex: Relance — votre projet"
                        className="w-full h-8 px-2 text-sm border border-border rounded-md bg-background"
                      />
                    </div>
                  </div>
                  <div className="mt-3">
                    <label className="text-xs text-muted-foreground block mb-1">Corps du message</label>
                    <textarea
                      rows={4}
                      value={step.body}
                      onChange={(e) => updateStep(i, "body", e.target.value)}
                      placeholder="Corps de la relance…"
                      className="w-full px-2 py-1.5 text-sm border border-border rounded-md bg-background resize-none"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-3 mt-4">
              <Button variant="outline" size="sm" onClick={addStep}>
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Ajouter une relance
              </Button>
              <Button size="sm" onClick={saveSequence} disabled={updateCampaign.isPending}>
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                {updateCampaign.isPending ? "Sauvegarde…" : "Sauvegarder la séquence"}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Leads dans la campagne" icon={Users} count={leads?.length ?? 0}>
          {!leads || leads.length === 0 ? (
            <Empty label="Aucun lead assigné à cette campagne" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {leads.map((lead) => {
                const leadEmails = emails?.filter((e) => e.leadId === lead.id) ?? [];
                const maxStep = leadEmails.reduce((m, e) => Math.max(m, e.sequenceStepIndex ?? 0), 0);
                const hasReplied = leadEmails.some((e) => e.status === "replied");
                return (
                  <li key={lead.id} className="flex items-center justify-between py-2.5 text-sm">
                    <Link href={`/leads/${lead.id}`}>
                      <div className="text-slate-700 hover:text-blue-600 cursor-pointer">
                        <span className="font-medium">
                          {lead.firstName} {lead.lastName}
                        </span>
                        <span className="text-slate-400 ml-2">{lead.company}</span>
                      </div>
                    </Link>
                    <div className="flex items-center gap-2">
                      {hasReplied && (
                        <span className="text-xs text-emerald-600 flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" /> Répondu
                        </span>
                      )}
                      {leadEmails.length > 0 && maxStep > 0 && !hasReplied && (
                        <span className="text-xs text-slate-400">Étape {maxStep + 1}</span>
                      )}
                      <StageBadge stage={lead.stage} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section
          title={`Emails${followUpEmails.length > 0 ? ` (${initialEmails.length} initiaux · ${followUpEmails.length} relances)` : ""}`}
          icon={Mail}
          count={emails?.length ?? 0}
        >
          {!emails || emails.length === 0 ? (
            <Empty label="Aucun email généré" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {emails.map((email) => (
                <li key={email.id} className="py-2.5 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        {(email.sequenceStepIndex ?? 0) > 0 && (
                          <span className="flex-shrink-0 text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5">
                            Relance {email.sequenceStepIndex}
                          </span>
                        )}
                        <span className="font-medium text-slate-700 truncate">
                          {email.subject}
                        </span>
                      </div>
                      {email.scheduledAt && email.status === "draft" && (email.sequenceStepIndex ?? 0) > 0 && (
                        <div className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                          <Clock className="w-3 h-3" />
                          Programmé pour le {new Date(email.scheduledAt).toLocaleDateString("fr-CA", {
                            day: "numeric", month: "short", year: "numeric",
                          })}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <EmailStatusBadge status={email.status} />
                      {(email.status === "sent" || email.status === "delivered" || email.status === "opened") && (
                        <button
                          className="text-xs text-slate-400 hover:text-emerald-600 transition-colors ml-1"
                          title="Marquer comme répondu (annule les relances)"
                          disabled={markingReplied === email.id}
                          onClick={() => markReplied(email.id)}
                        >
                          <MessageSquare className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent = "text-slate-900",
  small = false,
}: {
  label: string;
  value: number | string;
  accent?: string;
  small?: boolean;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 font-semibold ${accent} ${small ? "text-sm" : "text-2xl"}`}>
        {value}
      </div>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  count,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-slate-500" />
        <h2 className="font-semibold text-slate-900">{title}</h2>
        <span className="text-xs text-slate-500">({count})</span>
      </div>
      {children}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <div className="text-sm text-slate-400 text-center py-6">{label}</div>;
}
