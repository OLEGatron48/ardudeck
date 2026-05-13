/**
 * ArduPilot SITL Tab
 *
 * Configuration and control panel for ArduPilot SITL simulator.
 */

import { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { useArduPilotSitlStore, ARDUPILOT_MODELS } from '../../stores/ardupilot-sitl-store';
import { useConnectionStore } from '../../stores/connection-store';
import { useSettingsStore } from '../../stores/settings-store';
import type { VirtualRCState, ArduPilotVehicleType, ArduPilotReleaseTrack, ArduPilotFrameInfo, ArduPilotSimulatorType, GazeboBridgeStatus } from '../../../shared/ipc-channels';
import { getIpLocation } from '../../utils/ip-geolocation';
import SitlEnvironmentPanel from './SitlEnvironmentPanel';
import SitlFailurePanel from './SitlFailurePanel';
import { CustomFramePanel } from './CustomFramePanel';

const VEHICLE_TYPE_OPTIONS: Array<{ value: ArduPilotVehicleType; label: string; icon: string }> = [
  { value: 'copter', label: 'Copter', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { value: 'plane', label: 'Plane', icon: 'M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z' },
  { value: 'rover', label: 'Rover', icon: 'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z' },
  { value: 'sub', label: 'Sub', icon: 'M11 19v-4H9.5C7.01 15 5 12.99 5 10.5S7.01 6 9.5 6h5C17.99 6 20 8.01 20 10.5S17.99 15 15.5 15H14v4h-3z' },
];

const RELEASE_TRACK_OPTIONS: Array<{ value: ArduPilotReleaseTrack; label: string; description: string }> = [
  { value: 'stable', label: 'Stable', description: 'Recommended for most users' },
  { value: 'beta', label: 'Beta', description: 'Release candidates and testing' },
  { value: 'dev', label: 'Dev', description: 'Latest development builds' },
];

export default function ArduPilotSitlTab() {
  const {
    platformSupported,
    platformError,
    isRunning,
    isStarting,
    isStopping,
    isStatusChecked,
    isDownloading,
    downloadProgress,
    binaryInfo,
    output,
    vehicleType,
    model,
    releaseTrack,
    homeLocation,
    speedup,
    wipeOnStart,
    lastCommand,
    lastError,
    isRcSending,
    rcState,
    simulator,
    simAddress,
    framesLoading,
    framesCatalog,
    crashRecovery,
    start,
    stop,
    download,
    importBinaryFromFile,
    checkBinary,
    clearOutput,
    setVehicleType,
    setModel,
    setReleaseTrack,
    setHomeLocation,
    setSpeedup,
    setWipeOnStart,
    setSimulator,
    setSimAddress,
    startRcSender,
    stopRcSender,
    setRcState,
    resetRcState,
    initListeners,
    checkStatus,
    loadFrames,
    refreshFrames,
    acceptCrashRecovery,
    dismissCrashRecovery,
  } = useArduPilotSitlStore();

  const { connectionState } = useConnectionStore();
  const { setPendingSitlSwitch } = useSettingsStore();
  const outputRef = useRef<HTMLDivElement>(null);
  const simAddressInputRef = useRef<HTMLInputElement>(null);

  // Geolocation state
  const [isGettingLocation, setIsGettingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [gazeboBridgeStatus, setGazeboBridgeStatus] = useState<GazeboBridgeStatus>({ running: false });
  const [gazeboBridgeError, setGazeboBridgeError] = useState<string | null>(null);
  const [gazeboHost, setGazeboHost] = useState('127.0.0.1');
  const [gazeboPort, setGazeboPort] = useState(9002);
  const [gazeboModelName, setGazeboModelName] = useState('ardudeck_vehicle');

  // Resolve the user's approximate location via the shared fallback chain:
  // IP geolocation (no permission needed) → browser geolocation → default.
  // Matches the behaviour used elsewhere in the app (map, telemetry).
  const getCurrentLocation = useCallback(async () => {
    setIsGettingLocation(true);
    setLocationError(null);
    try {
      const loc = await getIpLocation();
      if (loc.source === 'default') {
        setLocationError('Unable to determine location');
        return;
      }
      setHomeLocation({
        lat: Math.round(loc.lat * 10000) / 10000,
        lng: Math.round(loc.lon * 10000) / 10000,
        // Preserve user's alt; 0 is valid (= ground at terrain). Don't coerce
        // falsy → 10: that spawns planes airborne and they drift.
        alt: homeLocation.alt,
        heading: homeLocation.heading,
      });
    } catch {
      setLocationError('Unable to get location');
    } finally {
      setIsGettingLocation(false);
    }
  }, [setHomeLocation, homeLocation.alt, homeLocation.heading]);

  // Initialize listeners and check status on mount
  useEffect(() => {
    checkStatus();
    window.electronAPI.gazeboBridgeStatus()
      .then(setGazeboBridgeStatus)
      .catch(() => {});
    const cleanup = initListeners();
    return cleanup;
  }, [initListeners, checkStatus]);

  const canAttachGazebo = connectionState.isConnected || isRunning;
  const startGazeboBridge = useCallback(async () => {
    setGazeboBridgeError(null);
    const source = connectionState.isConnected ? 'telemetry' : 'mavlink';
    const result = await window.electronAPI.gazeboBridgeStart({
      source,
      mavlinkUrl: 'tcp:127.0.0.1:5760',
      output: 'udp-json',
      gazeboHost,
      gazeboPort,
      modelName: gazeboModelName,
      rateHz: 20,
    });
    if (!result.success) {
      setGazeboBridgeError(result.error ?? 'Failed to start Gazebo bridge');
    }
    const status = await window.electronAPI.gazeboBridgeStatus();
    setGazeboBridgeStatus(status);
  }, [connectionState.isConnected, gazeboHost, gazeboModelName, gazeboPort]);

  const stopGazeboBridge = useCallback(async () => {
    setGazeboBridgeError(null);
    await window.electronAPI.gazeboBridgeStop();
    const status = await window.electronAPI.gazeboBridgeStatus();
    setGazeboBridgeStatus(status);
  }, []);

  // Fetch the upstream frame catalog once on mount. Stays cached after first
  // load — refreshFrames is the explicit user action behind the refresh icon.
  useEffect(() => {
    if (!framesCatalog) loadFrames();
  }, [framesCatalog, loadFrames]);

  // Check binary when vehicle type or release track changes
  useEffect(() => {
    checkBinary();
  }, [vehicleType, releaseTrack, checkBinary]);

  // Switch connection panel to TCP when SITL starts
  useEffect(() => {
    if (isRunning) {
      setPendingSitlSwitch(true);
    }
  }, [isRunning, setPendingSitlSwitch]);

  // Auto-scroll output to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  // Convert normalized value (-1 to +1) to PWM (1000-2000)
  const normalizedToPWM = (value: number): number => {
    return Math.round(1500 + value * 500);
  };

  // Update RC value
  const updateRC = useCallback(async (key: keyof VirtualRCState, value: number) => {
    await setRcState({ [key]: value });
  }, [setRcState]);

  // Build the frame picker data. Prefer upstream-fetched frames, fall back to
  // the small hardcoded list so the dropdown is never empty pre-fetch.
  const upstreamForVehicle: ArduPilotFrameInfo[] = useMemo(
    () => (framesCatalog?.frames ?? []).filter(f => f.vehicleType === vehicleType),
    [framesCatalog, vehicleType],
  );
  const fallbackForVehicle = useMemo(
    () => (ARDUPILOT_MODELS[vehicleType] ?? []).map<ArduPilotFrameInfo>(opt => ({
      value: opt.value,
      label: opt.label,
      vehicleType,
      category: 'Other',
      defaultParamFiles: [],
    })),
    [vehicleType],
  );
  const framesForVehicle = upstreamForVehicle.length > 0 ? upstreamForVehicle : fallbackForVehicle;

  // Group by category for <optgroup>; sort categories deterministically with
  // the most "default-y" group first to match user expectations.
  const groupedFrames = useMemo(() => {
    const order = ['Multirotor', 'Helicopter', 'Plane', 'Quadplane', 'Tailsitter', 'Rover', 'Boat', 'Sub', 'Other'] as const;
    const map = new Map<string, ArduPilotFrameInfo[]>();
    for (const frame of framesForVehicle) {
      const arr = map.get(frame.category) ?? [];
      arr.push(frame);
      map.set(frame.category, arr);
    }
    const sorted: Array<[string, ArduPilotFrameInfo[]]> = [];
    for (const cat of order) {
      const list = map.get(cat);
      if (list && list.length > 0) sorted.push([cat, list]);
    }
    // Surface unexpected categories last so we don't silently drop them.
    for (const [cat, list] of map) {
      if (!order.includes(cat as typeof order[number])) sorted.push([cat, list]);
    }
    return sorted;
  }, [framesForVehicle]);

  const selectedFrame = useMemo(
    () => framesForVehicle.find(f => f.value === model) ?? null,
    [framesForVehicle, model],
  );

  // Snap-back: if the saved model isn't valid for the current vehicle, pick
  // the first frame in its list. CRITICAL: only do this after the upstream
  // catalog has actually loaded — otherwise the bootstrap render (when
  // framesCatalog is still null and we're on the small hardcoded fallback)
  // would clobber persisted choices like "plane-tailsitter" that aren't in
  // the fallback but DO exist upstream.
  useEffect(() => {
    if (!framesCatalog) return;
    if (framesForVehicle.length === 0) return;
    if (!framesForVehicle.some(f => f.value === model)) {
      setModel(framesForVehicle[0]!.value);
    }
  }, [framesCatalog, framesForVehicle, model, setModel]);

  return (
    <div className="flex flex-col gap-4">
      <h1>123</h1>
      {/* Platform not supported banner */}

      {/* Platform Error */}
      {!platformSupported && platformError && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h3 className="text-sm font-medium text-red-400">Platform Error</h3>
              <p className="text-xs text-red-300/80 mt-1">{platformError}</p>
            </div>
          </div>
        </div>
      )}

      {/* Crash recovery — content varies by strike count. First strike
          (stable crashed) offers a track upgrade; second strike (upgraded
          track also crashed) offers a frame fallback. */}
      {crashRecovery && (
        <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-medium text-amber-400">
                SITL crashed during init ({crashRecovery.uptimeMs}ms{crashRecovery.signal ? ` · ${crashRecovery.signal}` : ''})
              </h3>
              {crashRecovery.kind === 'switch-track' ? (
                <>
                  <p className="text-xs text-content-secondary mt-1 leading-snug">
                    The <span className="font-mono text-content">{crashRecovery.failedTrack}</span> binary
                    doesn't run <span className="font-mono text-content">{crashRecovery.model}</span> on
                    this platform. The <span className="font-mono text-content">{crashRecovery.suggestedTrack}</span> track
                    is rebuilt nightly and ships fixes that haven't landed yet —
                    same SITL, just a newer build.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => { void acceptCrashRecovery(); }}
                      disabled={isStarting || isDownloading}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Switch to {crashRecovery.suggestedTrack} & retry
                    </button>
                    <button
                      onClick={dismissCrashRecovery}
                      className="px-3 py-1.5 text-xs font-medium text-content-secondary hover:text-content rounded-lg transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-content-secondary mt-1 leading-snug">
                    Both stable and dev binaries crash on{' '}
                    <span className="font-mono text-content">{crashRecovery.failedModel}</span> for this platform —
                    looks like an upstream physics bug specific to that frame.
                    Try <span className="font-mono text-content">{crashRecovery.suggestedModel}</span> instead;
                    it's the safe-default frame for this vehicle and is well-tested across builds.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => { void acceptCrashRecovery(); }}
                      disabled={isStarting || isDownloading}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Switch to {crashRecovery.suggestedModel} & retry
                    </button>
                    <button
                      onClick={dismissCrashRecovery}
                      className="px-3 py-1.5 text-xs font-medium text-content-secondary hover:text-content rounded-lg transition-colors"
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Vehicle Type Selection */}
      <div className="bg-surface-input border border-subtle rounded-lg p-4">
        <h3 className="text-sm font-medium text-content mb-3">Vehicle Type</h3>
        <div className="grid grid-cols-4 gap-2">
          {VEHICLE_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setVehicleType(opt.value)}
              disabled={isRunning || isStarting}
              className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-colors ${
                vehicleType === opt.value
                  ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                  : 'bg-surface border text-content-secondary hover:bg-surface hover:text-content'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d={opt.icon} />
              </svg>
              <span className="text-xs font-medium">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Configuration Row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Model & Release Track */}
        <div className="bg-surface-input border border-subtle rounded-lg p-4">
          <h3 className="text-sm font-medium text-content mb-3">Configuration</h3>
          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-content-secondary">Frame/Model</label>
                <FrameCatalogStatus
                  source={framesCatalog?.source}
                  fetchedAt={framesCatalog?.fetchedAt}
                  loading={framesLoading}
                  error={framesCatalog?.error}
                  onRefresh={refreshFrames}
                />
              </div>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isRunning || isStarting}
                className="w-full px-3 py-1.5 text-sm bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50"
              >
                {groupedFrames.length === 1
                  // Single-category vehicle (e.g. Sub) — flat list reads cleaner.
                  ? groupedFrames[0]![1].map((f) => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))
                  : groupedFrames.map(([category, frames]) => (
                      <optgroup key={category} label={category}>
                        {frames.map((f) => (
                          <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                      </optgroup>
                    ))
                }
              </select>
              <FrameDefaultsHint frame={selectedFrame} />
            </div>

            <CustomFramePanel />

            <div>
              <label className="block text-xs text-content-secondary mb-1">Release Track</label>
              <div className="grid grid-cols-3 gap-1">
                {RELEASE_TRACK_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setReleaseTrack(opt.value)}
                    disabled={isRunning || isStarting}
                    className={`px-2 py-1.5 text-xs rounded-lg border transition-colors ${
                      releaseTrack === opt.value
                        ? 'bg-blue-500/20 border-blue-500/50 text-blue-400'
                        : 'bg-surface border text-content-secondary hover:bg-surface'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                    title={opt.description}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="block text-xs text-content-secondary mb-1">Speedup</label>
                <input
                  type="number"
                  value={speedup}
                  onChange={(e) => setSpeedup(Math.max(1, parseInt(e.target.value) || 1))}
                  disabled={isRunning || isStarting}
                  min={1}
                  max={10}
                  className="w-full px-2 py-1.5 text-sm bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
                />
              </div>
              <div className="flex items-center gap-2 pt-5">
                <input
                  type="checkbox"
                  checked={wipeOnStart}
                  onChange={(e) => setWipeOnStart(e.target.checked)}
                  disabled={isRunning || isStarting}
                  className="w-4 h-4 rounded border bg-surface-raised text-blue-500 focus:ring-blue-500/50"
                />
                <label className="text-xs text-content-secondary">Wipe EEPROM</label>
              </div>
            </div>
          </div>
        </div>

        {/* Home Location */}
        <div className="bg-surface-input border border-subtle rounded-lg p-4">
          <h3 className="text-sm font-medium text-content mb-3">Home Location</h3>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-content-secondary mb-1">Latitude</label>
              <input
                type="number"
                step="0.0001"
                value={homeLocation.lat}
                onChange={(e) => setHomeLocation({ ...homeLocation, lat: parseFloat(e.target.value) || 0 })}
                disabled={isRunning || isStarting}
                className="w-full px-2 py-1.5 text-sm bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs text-content-secondary mb-1">Longitude</label>
              <input
                type="number"
                step="0.0001"
                value={homeLocation.lng}
                onChange={(e) => setHomeLocation({ ...homeLocation, lng: parseFloat(e.target.value) || 0 })}
                disabled={isRunning || isStarting}
                className="w-full px-2 py-1.5 text-sm bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs text-content-secondary mb-1">Altitude (m)</label>
              <input
                type="number"
                value={homeLocation.alt}
                onChange={(e) => setHomeLocation({ ...homeLocation, alt: parseFloat(e.target.value) || 0 })}
                disabled={isRunning || isStarting}
                className="w-full px-2 py-1.5 text-sm bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs text-content-secondary mb-1">Heading</label>
              <input
                type="number"
                value={homeLocation.heading}
                onChange={(e) => setHomeLocation({ ...homeLocation, heading: parseFloat(e.target.value) || 0 })}
                disabled={isRunning || isStarting}
                min={0}
                max={359}
                className="w-full px-2 py-1.5 text-sm bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-content-tertiary">Default: San Francisco Bay Area</p>
            <button
              onClick={getCurrentLocation}
              disabled={isRunning || isStarting || isGettingLocation}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-blue-400 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGettingLocation ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Getting...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  Use My Location
                </>
              )}
            </button>
          </div>
          {locationError && (
            <p className="mt-2 text-xs text-red-400">{locationError}</p>
          )}
        </div>
      </div>

      {/* Gazebo Python plugin — attaches to an already-running SITL or real FC */}
      <div className="bg-surface-input border border-emerald-500/30 rounded-lg p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${gazeboBridgeStatus.running ? 'bg-emerald-400' : 'bg-content-tertiary'}`} />
              <h3 className="text-sm font-medium text-content">Gazebo Python plugin</h3>
              <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-emerald-500/10 text-emerald-300">
                attach while running
              </span>
            </div>
            <p className="mt-1.5 text-xs text-content-tertiary leading-relaxed max-w-2xl">
              Start this after SITL is running or after a drone is connected. ArduDeck streams the current pose to Python,
              and the bridge publishes JSON pose packets to your Gazebo-side receiver.
            </p>
            {gazeboBridgeStatus.running && (
              <p className="mt-1.5 text-[10px] text-emerald-300 font-mono">
                Running pid={gazeboBridgeStatus.pid ?? 'unknown'} → {gazeboBridgeStatus.config?.gazeboHost}:{gazeboBridgeStatus.config?.gazeboPort}
              </p>
            )}
            {gazeboBridgeError && (
              <p className="mt-1.5 text-xs text-red-400">{gazeboBridgeError}</p>
            )}
          </div>

          <div className="flex flex-col gap-2 w-full lg:w-[30rem]">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[10px] text-content-secondary mb-1">Host</label>
                <input
                  type="text"
                  value={gazeboHost}
                  onChange={(e) => setGazeboHost(e.target.value)}
                  disabled={gazeboBridgeStatus.running}
                  className="w-full px-2 py-1.5 text-xs font-mono bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-[10px] text-content-secondary mb-1">Port</label>
                <input
                  type="number"
                  value={gazeboPort}
                  min={1}
                  max={65535}
                  onChange={(e) => setGazeboPort(Math.max(1, Math.min(65535, parseInt(e.target.value) || 9002)))}
                  disabled={gazeboBridgeStatus.running}
                  className="w-full px-2 py-1.5 text-xs font-mono bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                />
              </div>
              <div>
                <label className="block text-[10px] text-content-secondary mb-1">Model</label>
                <input
                  type="text"
                  value={gazeboModelName}
                  onChange={(e) => setGazeboModelName(e.target.value)}
                  disabled={gazeboBridgeStatus.running}
                  className="w-full px-2 py-1.5 text-xs font-mono bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500/50 disabled:opacity-50"
                />
              </div>
            </div>

            {gazeboBridgeStatus.running ? (
              <button
                type="button"
                onClick={() => void stopGazeboBridge()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-red-500/50 bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-500 transition-colors"
              >
                Stop Gazebo plugin
              </button>
            ) : (
              <button
                type="button"
                disabled={!canAttachGazebo}
                onClick={() => void startGazeboBridge()}
                title={canAttachGazebo ? 'Attach Gazebo to current SITL/drone telemetry' : 'Start SITL or connect a drone first'}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg border-2 border-emerald-400/80 bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/40 hover:bg-emerald-500 hover:border-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                Подключить Gazebo к работающему дрону/SITL
              </button>
            )}
            <p className="text-[10px] text-content-tertiary leading-relaxed">
              If ArduDeck is connected, source = current telemetry. If only local SITL is running, source = MAVLink tcp:127.0.0.1:5760.
            </p>
          </div>
        </div>
      </div>

      {/* External physics (Gazebo / JSBSim / X-Plane) — optional; default is built-in SITL */}
      <div className="bg-surface-input border border-subtle rounded-lg p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-3">
          <h3 className="text-sm font-medium text-content shrink-0">External physics</h3>
          <div className="flex flex-col sm:items-end gap-2 w-full sm:w-auto sm:max-w-md">
            {simulator === 'gazebo' ? (
              <div className="flex flex-wrap items-center gap-2 w-full sm:justify-end">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-300">
                  <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  External Gazebo physics selected — Start SITL will boot into that backend
                </span>
                <button
                  type="button"
                  disabled={isRunning || isStarting}
                  onClick={() => {
                    setSimulator('none');
                  }}
                  className="px-3 py-2 text-xs font-medium text-content-secondary border border-subtle rounded-lg hover:bg-surface-raised hover:text-content transition-colors disabled:opacity-50"
                >
                  Use built-in SITL physics
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={isRunning || isStarting}
                onClick={() => {
                  setSimulator('gazebo');
                  if (!simAddress.includes(':')) {
                    setSimAddress('127.0.0.1:9002');
                  }
                  queueMicrotask(() => simAddressInputRef.current?.focus());
                }}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border-2 border-emerald-400/80 bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/40 hover:bg-emerald-500 hover:border-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-[var(--bg-input)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-5 h-5 shrink-0 opacity-95" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                Use Gazebo as SITL physics on next start
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-content-tertiary mb-3 leading-relaxed">
          Built-in uses ArduPilot&apos;s packaged dynamics. For Gazebo in Docker, SITL stays on this host and connects with{' '}
          <code className="text-[11px] bg-surface-inset px-1 rounded">--sim gazebo</code> and{' '}
          <code className="text-[11px] bg-surface-inset px-1 rounded">--sim-address</code>.
          Choose a Gazebo frame (e.g. <span className="font-mono text-[11px]">gazebo-iris</span>) when using Iris worlds from the ArduPilot Gazebo plugin.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-content-secondary mb-1">Simulator</label>
            <select
              value={simulator}
              onChange={(e) => setSimulator(e.target.value as ArduPilotSimulatorType)}
              disabled={isRunning || isStarting}
              className="w-full px-2 py-1.5 text-sm bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50"
            >
              <option value="none">Built-in (default)</option>
              <option value="gazebo">Gazebo (plugin / Docker)</option>
              <option value="jsbsim">JSBSim</option>
              <option value="xplane">X-Plane</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-content-secondary mb-1">Sim address (host:port)</label>
            <input
              ref={simAddressInputRef}
              type="text"
              value={simAddress}
              onChange={(e) => setSimAddress(e.target.value)}
              disabled={isRunning || isStarting || simulator === 'none'}
              placeholder={simulator === 'gazebo' ? '127.0.0.1:9002' : '127.0.0.1'}
              className="w-full px-2 py-1.5 text-sm font-mono bg-surface-raised text-content border border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50"
            />
            {simulator === 'gazebo' && (
              <p className="mt-1.5 text-[10px] text-content-tertiary leading-relaxed">
                Publish the plugin FDM port from the container (e.g. <span className="font-mono">-p 9002:9002/udp</span>). Use{' '}
                <span className="font-mono">host.docker.internal:port</span> from a bridge inside Docker if needed.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Binary Status & Download */}
      <div className="bg-surface-input border border-subtle rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${binaryInfo?.exists ? 'bg-green-400' : 'bg-amber-400'}`} />
            <div>
              <span className="text-sm text-content">
                {vehicleType.charAt(0).toUpperCase() + vehicleType.slice(1)} ({releaseTrack})
              </span>
              <p className="text-xs text-content-secondary">
                {binaryInfo?.exists
                  ? `Ready at ${binaryInfo.path?.split(/[/\\]/).pop()}`
                  : 'Binary not installed'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!binaryInfo?.exists && !isDownloading && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={download}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={() => void importBinaryFromFile()}
                  title="Use a file you downloaded separately (e.g. if the network download fails). On Windows, Cygwin DLLs are fetched automatically when needed."
                  className="px-3 py-1.5 text-xs font-medium text-content bg-surface-inset border border-subtle hover:bg-surface-input rounded-lg transition-colors"
                >
                  Install from file…
                </button>
              </div>
            )}

            {isDownloading && (
              <div className="flex flex-col items-end gap-0.5 min-w-[10rem]">
                {downloadProgress ? (
                  <>
                    <div className="flex items-center gap-2 w-full justify-end">
                      <div className="w-32 h-2 bg-surface-inset rounded-full overflow-hidden shrink-0">
                        <div
                          className="h-full bg-blue-500 transition-all"
                          style={{ width: `${downloadProgress.progress}%` }}
                        />
                      </div>
                      <span className="text-xs text-content-secondary tabular-nums w-8 text-right">
                        {downloadProgress.progress}%
                      </span>
                    </div>
                    <span className="text-[10px] text-content-secondary text-right leading-tight max-w-[11rem]">
                      {downloadProgress.status === 'preparing'
                        ? 'Preparing SITL runtime (Cygwin DLLs on Windows)…'
                        : downloadProgress.status === 'downloading'
                          ? 'Downloading vehicle binary…'
                          : downloadProgress.status === 'extracting'
                            ? 'Extracting…'
                            : null}
                    </span>
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-xs text-content-secondary">
                    <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    Starting download…
                  </div>
                )}
              </div>
            )}

            {!isRunning ? (
              <button
                onClick={start}
                disabled={
                  !isStatusChecked ||
                  isStarting ||
                  !binaryInfo?.exists ||
                  connectionState.isConnected ||
                  (simulator !== 'none' && !simAddress.trim()) ||
                  (simulator === 'gazebo' && !simAddress.includes(':'))
                }
                title={
                  !isStatusChecked
                    ? 'Checking SITL status…'
                    : isStarting
                      ? 'SITL is starting…'
                      : !binaryInfo?.exists
                        ? 'Install the SITL binary (Download or Install from file)'
                        : connectionState.isConnected
                          ? 'Disconnect the flight controller (MSP) to run local SITL'
                          : simulator !== 'none' && !simAddress.trim()
                            ? 'Set a sim address for the external physics backend'
                            : simulator === 'gazebo' && !simAddress.includes(':')
                              ? 'Gazebo requires host:port (e.g. 127.0.0.1:9002)'
                              : undefined
                }
                className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-500 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isStarting ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Starting...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    </svg>
                    Start
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={stop}
                disabled={isStopping}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isStopping ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Stopping...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                    </svg>
                    Stop
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Connection hint */}
      {isRunning && !connectionState.isConnected && (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
          <svg className="w-5 h-5 text-blue-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-sm text-blue-300">
            <span className="font-medium">SITL is running!</span>{' '}
            Connect via TCP — <code className="px-1.5 py-0.5 bg-blue-500/20 rounded text-blue-200 font-mono">127.0.0.1:5760</code>
          </div>
        </div>
      )}

      {/* Virtual RC Control */}
      {isRunning && (
        <div className="bg-surface-input border border-subtle rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <h3 className="text-sm font-medium text-content">Virtual RC Control (UDP)</h3>
              <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${isRcSending ? 'bg-green-500/20 text-green-400' : 'bg-surface-raised text-content-secondary'}`}>
                {isRcSending ? '50Hz' : 'Off'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={isRcSending ? stopRcSender : startRcSender}
                className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                  isRcSending
                    ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                    : 'text-green-400 bg-green-500/10 hover:bg-green-500/20'
                }`}
              >
                {isRcSending ? 'Stop' : 'Start'} RC
              </button>
              <button
                onClick={resetRcState}
                className="px-2 py-1 text-xs text-content-secondary hover:text-content bg-surface-raised hover:bg-surface-raised rounded transition-colors"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Main sticks */}
          <div className="grid grid-cols-4 gap-3 mb-3">
            {/* Throttle */}
            <div>
              <label className="block text-xs text-content-secondary mb-1">
                Throttle <span className="text-content-tertiary">{normalizedToPWM(rcState.throttle)}</span>
              </label>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.1"
                value={rcState.throttle}
                onChange={(e) => updateRC('throttle', parseFloat(e.target.value))}
                className="w-full h-2 bg-surface-raised rounded-lg appearance-none cursor-pointer accent-amber-500"
              />
            </div>
            <div>
              <label className="block text-xs text-content-secondary mb-1">
                Roll <span className="text-content-tertiary">{normalizedToPWM(rcState.roll)}</span>
              </label>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.1"
                value={rcState.roll}
                onChange={(e) => updateRC('roll', parseFloat(e.target.value))}
                className="w-full h-2 bg-surface-raised rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-content-secondary mb-1">
                Pitch <span className="text-content-tertiary">{normalizedToPWM(rcState.pitch)}</span>
              </label>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.1"
                value={rcState.pitch}
                onChange={(e) => updateRC('pitch', parseFloat(e.target.value))}
                className="w-full h-2 bg-surface-raised rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-content-secondary mb-1">
                Yaw <span className="text-content-tertiary">{normalizedToPWM(rcState.yaw)}</span>
              </label>
              <input
                type="range"
                min="-1"
                max="1"
                step="0.1"
                value={rcState.yaw}
                onChange={(e) => updateRC('yaw', parseFloat(e.target.value))}
                className="w-full h-2 bg-surface-raised rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          </div>

          {/* AUX channels */}
          <div className="grid grid-cols-4 gap-3 pt-3 border-t border-subtle">
            {(['aux1', 'aux2', 'aux3', 'aux4'] as const).map((key, idx) => (
              <div key={key}>
                <label className={`block text-xs mb-1 ${key === 'aux4' ? 'text-amber-400 font-medium' : 'text-content-secondary'}`}>
                  {key === 'aux4' ? 'AUX4 (ARM)' : `AUX${idx + 1}`}{' '}
                  <span className={key === 'aux4' ? 'text-amber-500' : 'text-content-tertiary'}>{normalizedToPWM(rcState[key])}</span>
                </label>
                <input
                  type="range"
                  min="-1"
                  max="1"
                  step="0.1"
                  value={rcState[key]}
                  onChange={(e) => updateRC(key, parseFloat(e.target.value))}
                  className={`w-full h-2 bg-surface-raised rounded-lg appearance-none cursor-pointer ${key === 'aux4' ? 'accent-amber-500' : 'accent-green-500'}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Environment Simulation & Failure Injection - shown when SITL running + connected */}
      {isRunning && connectionState.isConnected && (
        <>
          <SitlEnvironmentPanel />
          <SitlFailurePanel />
        </>
      )}

      {/* Error display */}
      {lastError && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <svg className="w-5 h-5 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="text-sm text-red-300">{lastError}</div>
        </div>
      )}

      {/* Output log */}
      <div className="flex-1 flex flex-col overflow-hidden bg-surface-input border border-subtle rounded-lg min-h-[200px]">
        <div className="flex items-center justify-between px-3 py-2 border-b border-subtle bg-surface-input">
          <span className="text-xs font-medium text-content-secondary">Console Output</span>
          <div className="flex items-center gap-2">
            {lastCommand && (
              <span className="text-xs text-content-secondary font-mono truncate max-w-md" title={lastCommand}>
                {lastCommand.split('/').pop()?.slice(0, 50)}
              </span>
            )}
            <button
              onClick={clearOutput}
              disabled={output.length === 0}
              className="px-2 py-1 text-xs text-content-secondary hover:text-content transition-colors disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
        <div
          ref={outputRef}
          className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed max-h-[300px]"
        >
          {output.length === 0 ? (
            <div className="text-content-tertiary italic">
              No output yet. Start SITL to see process output.
            </div>
          ) : (
            output.map((line, idx) => (
              <div
                key={idx}
                className={
                  line.includes('ERROR') || line.includes('error')
                    ? 'text-red-400'
                    : line.startsWith('---')
                      ? 'text-blue-400 font-medium'
                      : line.includes('ArduPilot') || line.includes('SITL')
                        ? 'text-green-400'
                        : 'text-content'
                }
              >
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Frame catalog UI helpers
// =============================================================================

/**
 * Tiny status pill + refresh button shown next to the Frame/Model label.
 * Tells the user where the dropdown contents came from (upstream / cache /
 * fallback) and lets them force-refresh.
 */
function FrameCatalogStatus({
  source,
  fetchedAt,
  loading,
  error,
  onRefresh,
}: {
  source: 'fresh' | 'cached' | 'fallback' | undefined;
  fetchedAt: string | undefined;
  loading: boolean;
  error: string | undefined;
  onRefresh: () => void;
}) {
  const ageLabel = useMemo(() => relativeAge(fetchedAt), [fetchedAt]);

  const variant =
    loading              ? { dot: 'bg-blue-400 animate-pulse',   text: 'text-content-tertiary', label: 'syncing…' } :
    source === 'fresh'   ? { dot: 'bg-emerald-400',              text: 'text-content-tertiary', label: ageLabel ? `synced ${ageLabel}` : 'synced' } :
    source === 'cached'  ? { dot: 'bg-amber-400',                text: 'text-amber-400',        label: ageLabel ? `cached · ${ageLabel}` : 'cached' } :
    source === 'fallback'? { dot: 'bg-rose-400',                 text: 'text-rose-400',         label: 'offline · default list' } :
                           { dot: 'bg-content-tertiary',         text: 'text-content-tertiary', label: 'pending' };

  const tooltip = error
    ? `Couldn't reach upstream: ${error}\nClick to retry.`
    : 'Frame list mirrors ArduPilot upstream `vehicleinfo.py`. Click to refresh.';

  return (
    <div className="flex items-center gap-1.5">
      <span className={`inline-flex items-center gap-1 text-[10px] ${variant.text}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${variant.dot}`} />
        {variant.label}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        title={tooltip}
        className="inline-flex items-center justify-center w-5 h-5 rounded text-content-tertiary hover:text-content hover:bg-surface-raised transition-colors disabled:opacity-50"
      >
        <svg
          className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0114-3.5M20 15a8 8 0 01-14 3.5" />
        </svg>
      </button>
    </div>
  );
}

/**
 * One-line summary under the dropdown showing which upstream `.parm` file(s)
 * will be stacked behind the ArduDeck overlay at launch. Builds confidence
 * that the frame's defaults are real (esp. for tailsitter / VTOL).
 */
function FrameDefaultsHint({ frame }: { frame: ArduPilotFrameInfo | null }) {
  if (!frame) return null;
  if (frame.defaultParamFiles.length === 0) {
    return (
      <p className="mt-1.5 text-[10px] text-content-tertiary leading-tight">
        No upstream defaults — ArduDeck baseline only.
      </p>
    );
  }
  // Strip "default_params/" prefix for readability.
  const names = frame.defaultParamFiles.map(f => f.replace(/^default_params\//, ''));
  const list = names.length === 1
    ? names[0]
    : `${names.length} files (${names.join(' + ')})`;
  return (
    <p className="mt-1.5 text-[10px] text-content-tertiary leading-tight" title={frame.defaultParamFiles.join('\n')}>
      Loads <span className="font-mono text-content-secondary">{list}</span> on start.
    </p>
  );
}

/** Format a relative age like "2h ago", "3d ago" — for the catalog status pill. */
function relativeAge(iso: string | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  if (ms < 60_000) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
