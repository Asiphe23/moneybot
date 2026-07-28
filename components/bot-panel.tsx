'use client';

import { useMemo } from 'react';
import { Bot, Play, Square, RotateCcw, TrendingUp, TrendingDown, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useDerivWSContext } from '@/components/custom/deriv-ws-provider';
import {
  useOverUnderBot,
  OVER_UNDER_BOT_SYMBOL,
  type BotLogType,
} from '@/hooks/use-over-under-bot';

interface BotPanelProps {
  isConnected: boolean;
  isAuthenticated: boolean;
  currency: string;
}

const LOG_STYLES: Record<BotLogType, string> = {
  info: 'text-muted-foreground',
  buy: 'text-foreground',
  win: 'text-emerald-600 dark:text-emerald-500',
  loss: 'text-destructive',
  error: 'text-destructive',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function BotPanel({
  isConnected,
  isAuthenticated,
  currency,
  lastDigit,
  currentTick,
}: BotPanelProps) {
  const { ws } = useDerivWSContext();

  const { isRunning, settings, setSettings, stats, log, start, stop, resetStats } =
    useOverUnderBot({
      ws,
      isConnected,
      isAuthenticated,
      currency,
      lastDigit,
      currentTick,
    });

  const maxStake = useMemo(
    () => settings.initialStake * settings.maxStakeMultiple,
    [settings.initialStake, settings.maxStakeMultiple]
  );

  const winRate =
    stats.runs > 0 ? Math.round((stats.wins / stats.runs) * 100) : 0;

  const profitPositive = stats.totalProfit >= 0;

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {/* Strategy header */}
      <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-muted/20 p-3 sm:p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="space-y-0.5">
            <h2 className="text-sm font-bold text-foreground">Over 2 / Under 7 Bot</h2>
            <p className="text-xs text-muted-foreground text-pretty">
              Waits for a low digit (0-2), then buys{' '}
              <span className="font-medium text-foreground">Over 2</span>; waits for a high
              digit (7-9), then buys <span className="font-medium text-foreground">Under 7</span>.
              1-tick contracts on Volatility 100.
            </p>
          </div>
        </div>
        <Badge
          variant={isRunning ? 'default' : 'secondary'}
          className="shrink-0 gap-1.5"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isRunning ? 'bg-primary-foreground animate-pulse' : 'bg-muted-foreground'
            }`}
            aria-hidden="true"
          />
          {isRunning ? 'Running' : 'Idle'}
        </Badge>
      </div>

      {/* Settings */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="bot-initial-stake" className="text-xs text-muted-foreground">
            Initial stake
          </Label>
          <Input
            id="bot-initial-stake"
            type="number"
            min={0.35}
            step="0.01"
            value={settings.initialStake}
            disabled={isRunning}
            labelRight={currency}
            onKeyDown={(e) => {
              if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
            }}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setSettings((prev) => ({
                ...prev,
                initialStake: isNaN(val) ? 0 : val,
              }));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-multiplier" className="text-xs text-muted-foreground">
            Martingale ×
          </Label>
          <Input
            id="bot-multiplier"
            type="number"
            min={1}
            step="0.1"
            value={settings.multiplier}
            disabled={isRunning}
            onKeyDown={(e) => {
              if (['e', 'E', '+', '-'].includes(e.key)) e.preventDefault();
            }}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              setSettings((prev) => ({
                ...prev,
                multiplier: isNaN(val) ? 1 : val,
              }));
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-max-multiple" className="text-xs text-muted-foreground">
            Max stake ×
          </Label>
          <Input
            id="bot-max-multiple"
            type="number"
            min={1}
            step="1"
            value={settings.maxStakeMultiple}
            disabled={isRunning}
            onKeyDown={(e) => {
              if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault();
            }}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              setSettings((prev) => ({
                ...prev,
                maxStakeMultiple: isNaN(val) ? 1 : val,
              }));
            }}
          />
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        After a loss the stake grows to {settings.multiplier}× (max {maxStake.toFixed(2)} {currency}); it
        resets to {settings.initialStake.toFixed(2)} {currency} after a win.
      </p>

      {/* Live stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="Trades" value={String(stats.runs)} />
        <StatCard label="Win rate" value={`${winRate}%`} sub={`${stats.wins}W / ${stats.losses}L`} />
        <StatCard label="Next stake" value={`${stats.currentStake.toFixed(2)}`} sub={currency} />
        <StatCard
          label="Net P/L"
          value={`${profitPositive ? '+' : ''}${stats.totalProfit.toFixed(2)}`}
          sub={currency}
          tone={profitPositive ? 'positive' : 'negative'}
          icon={profitPositive ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
        />
      </div>

      {/* Controls */}
      <div className="flex gap-2">
        {isRunning ? (
          <Button className="h-11 flex-1 rounded-full" variant="destructive" onClick={stop}>
            <Square className="mr-2 h-4 w-4" aria-hidden="true" />
            Stop bot
          </Button>
        ) : (
          <Button
            className="h-11 flex-1 rounded-full"
            onClick={start}
            disabled={!isConnected || !isAuthenticated || settings.initialStake <= 0}
          >
            <Play className="mr-2 h-4 w-4" aria-hidden="true" />
            Start bot
          </Button>
        )}
        <Button
          variant="outline"
          className="h-11 rounded-full px-4"
          onClick={resetStats}
          disabled={isRunning}
          aria-label="Reset statistics and log"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {!isAuthenticated && (
        <p className="text-center text-xs text-muted-foreground">
          Log in to your Deriv account to run the bot with real trades.
        </p>
      )}

      {/* Run log */}
      <div className="rounded-xl border border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-foreground">Run log</span>
          <span className="text-[11px] text-muted-foreground">{OVER_UNDER_BOT_SYMBOL}</span>
        </div>
        <div className="max-h-64 overflow-y-auto p-2">
          {log.length === 0 ? (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              No activity yet. Press{' '}
              <span className="font-medium text-foreground">Start bot</span> to begin.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {log.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-start gap-2 rounded-md px-2 py-1 text-xs odd:bg-muted/30"
                >
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {formatTime(entry.time)}
                  </span>
                  <span className={`text-pretty ${LOG_STYLES[entry.type]}`}>{entry.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = 'neutral',
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'neutral' | 'positive' | 'negative';
  icon?: React.ReactNode;
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-emerald-600 dark:text-emerald-500'
      : tone === 'negative'
        ? 'text-destructive'
        : 'text-foreground';
  return (
    <div className="rounded-lg border border-border bg-muted/20 p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={`flex items-center gap-1 text-base font-bold ${toneClass}`}>
        {icon}
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
