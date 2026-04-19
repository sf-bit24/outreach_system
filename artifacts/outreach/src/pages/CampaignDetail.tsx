import { useParams, Link } from "wouter";
import {
  useGetCampaign,
  useListLeads,
  useListEmails,
  useStartCampaign,
  usePauseCampaign,
  getGetCampaignQueryKey,
  getListLeadsQueryKey,
  getListEmailsQueryKey,
  getListCampaignsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Play, Pause, Mail, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import StageBadge from "@/components/StageBadge";
import { EmailStatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/hooks/use-toast";

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

  function refresh() {
    queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(campaignId) });
    queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
  }

  function handleStart() {
    startCampaign.mutate(
      { id: campaignId },
      {
        onSuccess: () => {
          refresh();
          toast({ title: "Campaign started" });
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
          toast({ title: "Campaign paused" });
        },
      },
    );
  }

  if (isLoading) return <div className="p-8 text-slate-500">Loading...</div>;
  if (!campaign) return <div className="p-8 text-slate-500">Campaign not found</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <Link href="/campaigns">
        <a className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to campaigns
        </a>
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
              <Play className="w-4 h-4 mr-2" /> Start
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-8">
        <Stat label="Total leads" value={campaign.totalLeads} />
        <Stat label="Contacted" value={campaign.contacted} />
        <Stat label="Replied" value={campaign.replied} accent="text-emerald-600" />
        <Stat
          label="Daily limit"
          value={`${campaign.dailyLimit}/day · ${campaign.sendingDelayMinutes}m delay`}
          small
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Leads in campaign" icon={Users} count={leads?.length ?? 0}>
          {!leads || leads.length === 0 ? (
            <Empty label="No leads assigned to this campaign" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {leads.map((lead) => (
                <li key={lead.id} className="flex items-center justify-between py-2.5 text-sm">
                  <Link href={`/leads/${lead.id}`}>
                    <a className="text-slate-700 hover:text-blue-600">
                      <span className="font-medium">
                        {lead.firstName} {lead.lastName}
                      </span>
                      <span className="text-slate-400 ml-2">{lead.company}</span>
                    </a>
                  </Link>
                  <StageBadge stage={lead.stage} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Emails in campaign" icon={Mail} count={emails?.length ?? 0}>
          {!emails || emails.length === 0 ? (
            <Empty label="No emails generated yet" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {emails.map((email) => (
                <li key={email.id} className="py-2.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-700 truncate flex-1 mr-3">
                      {email.subject}
                    </span>
                    <EmailStatusBadge status={email.status} />
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
