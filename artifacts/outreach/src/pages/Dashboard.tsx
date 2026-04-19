import {
  useGetDashboardStats,
  useGetPipeline,
  useGetActivity,
} from "@workspace/api-client-react";
import {
  getGetDashboardStatsQueryKey,
  getGetPipelineQueryKey,
  getGetActivityQueryKey,
} from "@workspace/api-client-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { TrendingUp, Users, Mail, MailOpen, CornerDownRight, Megaphone } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const stageColors: Record<string, string> = {
  raw: "#94a3b8",
  enriched: "#60a5fa",
  email_generated: "#a78bfa",
  contacted: "#fbbf24",
  replied: "#34d399",
  converted: "#22c55e",
  unsubscribed: "#f87171",
};

export default function Dashboard() {
  const { data: stats, isLoading: statsLoading } = useGetDashboardStats({
    query: { queryKey: getGetDashboardStatsQueryKey() },
  });
  const { data: pipeline, isLoading: pipelineLoading } = useGetPipeline({
    query: { queryKey: getGetPipelineQueryKey() },
  });
  const { data: activity, isLoading: activityLoading } = useGetActivity({
    query: { queryKey: getGetActivityQueryKey() },
  });

  const statCards = [
    {
      label: "Total Leads",
      value: stats?.totalLeads ?? 0,
      icon: Users,
      color: "text-blue-600",
      bg: "bg-blue-50",
    },
    {
      label: "Emails Sent",
      value: stats?.emailsSent ?? 0,
      icon: Mail,
      color: "text-purple-600",
      bg: "bg-purple-50",
    },
    {
      label: "Open Rate",
      value: `${stats?.openRate ?? 0}%`,
      icon: MailOpen,
      color: "text-amber-600",
      bg: "bg-amber-50",
    },
    {
      label: "Reply Rate",
      value: `${stats?.replyRate ?? 0}%`,
      icon: TrendingUp,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
    },
    {
      label: "Replies",
      value: stats?.emailsReplied ?? 0,
      icon: CornerDownRight,
      color: "text-green-600",
      bg: "bg-green-50",
    },
    {
      label: "Active Campaigns",
      value: stats?.activeCampaigns ?? 0,
      icon: Megaphone,
      color: "text-indigo-600",
      bg: "bg-indigo-50",
    },
  ];

  const activityTypeLabels: Record<string, string> = {
    lead_added: "Lead added",
    lead_enriched: "Lead enriched",
    email_generated: "Email generated",
    email_sent: "Email sent",
    email_opened: "Email opened",
    email_replied: "Email replied",
    campaign_started: "Campaign started",
    campaign_paused: "Campaign paused",
  };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Your outreach pipeline at a glance</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {statCards.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="bg-card border border-card-border rounded-lg p-4">
            <div className={`w-8 h-8 ${bg} rounded-md flex items-center justify-center mb-3`}>
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
            <div className="text-2xl font-bold text-foreground tabular-nums">
              {statsLoading ? <span className="text-muted-foreground">—</span> : value}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 font-medium">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Pipeline chart */}
        <div className="lg:col-span-3 bg-card border border-card-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Lead Pipeline</h2>
          {pipelineLoading ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
              Loading...
            </div>
          ) : pipeline && pipeline.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={pipeline} barCategoryGap={20}>
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    borderRadius: "0.375rem",
                    border: "1px solid hsl(var(--border))",
                    boxShadow: "var(--shadow-sm)",
                  }}
                  cursor={{ fill: "hsl(var(--muted))" }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {pipeline.map((entry) => (
                    <Cell
                      key={entry.stage}
                      fill={stageColors[entry.stage] ?? "#60a5fa"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
              No leads yet. Add your first lead to get started.
            </div>
          )}
        </div>

        {/* Activity feed */}
        <div className="lg:col-span-2 bg-card border border-card-border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-foreground mb-4">Recent Activity</h2>
          {activityLoading ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : activity && activity.length > 0 ? (
            <div className="space-y-3">
              {activity.slice(0, 8).map((item) => (
                <div key={item.id} className="flex items-start gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-foreground leading-snug">{item.description}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No activity yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
