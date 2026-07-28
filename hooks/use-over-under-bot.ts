'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DerivWS, Tick } from '@deriv/core';

/**
 * "Over 2 / Under 7" martingale strategy runner (imported from the Deriv DBot
 * XML). Drives real trades imperatively on the shared authenticated WebSocket:
 *
 *   - Each tick, arm `touchedLow` when the last digit is 0/1/2 and `touchedHigh`
 *     when it is 7/8/9.
 *   - When armed low and a later digit is > 2 → buy DIGITOVER (barrier 2).
 *   - When armed high and a later digit is < 7 → buy DIGITUNDER (barrier 7).
 *   - After a win, reset the stake to the initial stake. After a loss, multiply
 *     the stake by the martingale multiplier, capped at `maxStakeMultiple` × the
 *     initial stake.
 *
 * Contracts are 1-tick digit contracts. The runner waits for each contract to
 * settle (proposal_open_contract → is_sold) before scanning for the next entry.
 */

export const OVER_UNDER_BOT_SYMBOL = 'R_100';

export interface BotSettings {
  /** Base stake used on the first trade and after every win. */
  initialStake: number;
  /** Multiplier applied to the stake after a loss (XML default: 2.5). */
  multiplier: number;
  /** Stake cap expressed as a multiple of the initial stake (XML default: 20). */
  maxStakeMultiple: number;
}

export interface BotStats {
  runs: number;
  wins: number;
  losses: number;
  currentStake: number;
  totalProfit: number;
}

export type BotLogType = 'info' | 'buy' | 'win' | 'loss' | 'error';

export interface BotLogEntry {
  id: string;
  time: number;
  type: BotLogType;
  message: string;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  initialStake: 1,
  multiplier: 2.5,
  maxStakeMultiple: 20,
};

interface UseOverUnderBotParams {
  ws: DerivWS | null;
  isConnected: boolean;
  isAuthenticated: boolean;
  currency: string;
  /** Last digit of the most recent tick for the traded symbol. */
  lastDigit: number | null;
  /** The current tick object — changes on every tick, used to drive the loop. */
  currentTick: Tick | null;
}

interface RuntimeState {
  touchedLow: boolean;
  touchedHigh: boolean;
  prediction: number;
  stake: number;
  /** 'idle' = scanning ticks for an entry, 'busy' = a contract is in flight. */
  phase: 'idle' | 'busy';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function useOverUnderBot({
  ws,
  isConnected,
  isAuthenticated,
  currency,
  lastDigit,
  currentTick,
}: UseOverUnderBotParams) {
  const [isRunning, setIsRunning] = useState(false);
  const [settings, setSettings] = useState<BotSettings>(DEFAULT_BOT_SETTINGS);
  const [stats, setStats] = useState<BotStats>({
    runs: 0,
    wins: 0,
    losses: 0,
    currentStake: DEFAULT_BOT_SETTINGS.initialStake,
    totalProfit: 0,
  });
  const [log, setLog] = useState<BotLogEntry[]>([]);

  const runningRef = useRef(false);
  const settingsRef = useRef(settings);
  const lastDigitRef = useRef<number | null>(lastDigit);
  const runtime = useRef<RuntimeState>({
    touchedLow: false,
    touchedHigh: false,
    prediction: 2,
    stake: DEFAULT_BOT_SETTINGS.initialStake,
    phase: 'idle',
  });

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    lastDigitRef.current = lastDigit;
  }, [lastDigit]);

  const addLog = useCallback((type: BotLogType, message: string) => {
    setLog((prev) =>
      [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          time: Date.now(),
          type,
          message,
        },
        ...prev,
      ].slice(0, 100)
    );
  }, []);

  /** Subscribe to a contract's updates and resolve with its profit once sold. */
  const waitForSettlement = useCallback(
    (contractId: number): Promise<number> => {
      return new Promise((resolve, reject) => {
        if (!ws) {
          reject(new Error('WebSocket unavailable'));
          return;
        }
        let settled = false;
        ws.subscribe({ proposal_open_contract: 1, contract_id: contractId }, (data) => {
          const poc = (data as { proposal_open_contract?: { is_sold?: number; profit?: number | string } })
            .proposal_open_contract;
          if (!poc || settled) return;
          if (poc.is_sold === 1) {
            settled = true;
            resolve(Number(poc.profit ?? 0));
          }
        })
          .then((sub) => {
            if (settled) sub.unsubscribe();
            else {
              // Poll guard: once resolved elsewhere, ensure we clean up.
              const cleanup = setInterval(() => {
                if (settled) {
                  clearInterval(cleanup);
                  sub.unsubscribe();
                }
              }, 500);
            }
          })
          .catch(reject);
      });
    },
    [ws]
  );

  /** Request a proposal, buy it, wait for settlement, then apply martingale. */
  const fireTrade = useCallback(
    async (contractType: 'DIGITOVER' | 'DIGITUNDER', barrier: number) => {
      const rt = runtime.current;
      if (!ws) return;
      rt.phase = 'busy';

      const amount = round2(rt.stake);
      const label = contractType === 'DIGITOVER' ? `Over ${barrier}` : `Under ${barrier}`;

      try {
        addLog('buy', `Entering ${label} · stake ${amount.toFixed(2)} ${currency}`);

        const proposalResp = await ws.send<{
          proposal?: { id: string; ask_price: number };
        }>({
          proposal: 1,
          amount,
          basis: 'stake',
          contract_type: contractType,
          currency,
          duration: 1,
          duration_unit: 't',
          underlying_symbol: OVER_UNDER_BOT_SYMBOL,
          barrier: String(barrier),
        });

        const proposal = proposalResp.proposal;
        if (!proposal) throw new Error('No proposal returned');

        const buyResp = await ws.send<{
          buy?: { contract_id: number };
        }>({ buy: proposal.id, price: String(proposal.ask_price) });

        const contractId = buyResp.buy?.contract_id;
        if (!contractId) throw new Error('Buy failed');

        const profit = await waitForSettlement(contractId);
        const won = profit > 0;

        const cfg = settingsRef.current;
        if (won) {
          rt.stake = cfg.initialStake;
        } else {
          const maxStake = cfg.initialStake * cfg.maxStakeMultiple;
          const next = rt.stake * cfg.multiplier;
          rt.stake = next > maxStake ? maxStake : next;
        }

        setStats((prev) => ({
          runs: prev.runs + 1,
          wins: prev.wins + (won ? 1 : 0),
          losses: prev.losses + (won ? 0 : 1),
          currentStake: round2(rt.stake),
          totalProfit: round2(prev.totalProfit + profit),
        }));

        addLog(
          won ? 'win' : 'loss',
          `${won ? 'Won' : 'Lost'} ${label} · ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} ${currency} · next stake ${round2(
            rt.stake
          ).toFixed(2)} ${currency}`
        );
      } catch (err) {
        addLog('error', err instanceof Error ? err.message : 'Trade failed');
        // Stop the bot on a hard error so the user can review.
        runningRef.current = false;
        setIsRunning(false);
      } finally {
        rt.phase = 'idle';
      }
    },
    [ws, currency, addLog, waitForSettlement]
  );

  /** Evaluate the strategy against the latest digit (runs once per tick). */
  const processTick = useCallback(() => {
    const digit = lastDigitRef.current;
    const rt = runtime.current;
    if (!runningRef.current || rt.phase !== 'idle' || digit === null) return;

    if (digit === 0 || digit === 1 || digit === 2) rt.touchedLow = true;
    if (digit === 7 || digit === 8 || digit === 9) rt.touchedHigh = true;

    if (rt.touchedLow && digit > 2) {
      rt.prediction = 2;
      rt.touchedLow = false;
      void fireTrade('DIGITOVER', 2);
    } else if (rt.touchedHigh && digit < 7) {
      rt.prediction = 7;
      rt.touchedHigh = false;
      void fireTrade('DIGITUNDER', 7);
    }
  }, [fireTrade]);

  const processTickRef = useRef(processTick);
  useEffect(() => {
    processTickRef.current = processTick;
  }, [processTick]);

  // Drive the strategy off every new tick.
  useEffect(() => {
    if (!currentTick) return;
    processTickRef.current();
  }, [currentTick]);

  const start = useCallback(() => {
    if (!isAuthenticated) {
      addLog('error', 'Log in to a Deriv account before starting the bot.');
      return;
    }
    if (!isConnected) {
      addLog('error', 'Waiting for the market connection. Try again in a moment.');
      return;
    }
    const cfg = settingsRef.current;
    runtime.current = {
      touchedLow: false,
      touchedHigh: false,
      prediction: 2,
      stake: cfg.initialStake,
      phase: 'idle',
    };
    setStats((prev) => ({ ...prev, currentStake: round2(cfg.initialStake) }));
    runningRef.current = true;
    setIsRunning(true);
    addLog(
      'info',
      `Bot started on Volatility 100 · initial ${cfg.initialStake.toFixed(2)} ${currency} · ${cfg.multiplier}x martingale · cap ${(
        cfg.initialStake * cfg.maxStakeMultiple
      ).toFixed(2)} ${currency}`
    );
  }, [isAuthenticated, isConnected, currency, addLog]);

  const stop = useCallback(() => {
    runningRef.current = false;
    setIsRunning(false);
    runtime.current.phase = 'idle';
    addLog('info', 'Bot stopped.');
  }, [addLog]);

  const resetStats = useCallback(() => {
    setStats({
      runs: 0,
      wins: 0,
      losses: 0,
      currentStake: settingsRef.current.initialStake,
      totalProfit: 0,
    });
    setLog([]);
  }, []);

  // Safety: stop the bot if the connection drops.
  useEffect(() => {
    if (!isConnected && runningRef.current) {
      runningRef.current = false;
      setIsRunning(false);
      addLog('error', 'Connection lost — bot stopped.');
    }
  }, [isConnected, addLog]);

  return {
    isRunning,
    settings,
    setSettings,
    stats,
    log,
    start,
    stop,
    resetStats,
  };
}
