// ============================================================
// ToubkalCAD – src/index.tsx
// Entry point: WASM init → splash screen → CADLayout
// ============================================================

import './types/index';
import React, { useEffect, useState } from 'react';
import { createRoot }          from 'react-dom/client';
import initOpenCascade         from 'opencascade.js';
import { CADLayout }           from './components/CADLayout';
import { ParameterModal }      from './components/ParameterModal';
import { ErrorBoundary }       from './components/ErrorBoundary';
import { CADGeometryRegistry } from './services/CADGeometryRegistry';
import { ThreeMeshCache }      from './services/ThreeMeshCache';
import { initTheme }           from './utils/theme';
import './styles/global.css';

// Restore the saved light/dark theme before first paint.
initTheme();

// ─── Engineering CAD Illustration (SVG) ──────────────────────────────────────
// Isometric box + cylinder assembly with technical annotations.
// Box:  width=110, depth=90, height=75  (iso scale 1px = 1 unit)
//   A(280,270) B(375,325) E(280,195) F(375,250) G(202,240) H(297,295) C(297,370)
// Cylinder: base at (289,245), top at (289,155), rx=22, ry=11
const CADIllustration: React.FC = () => (
  <svg viewBox="0 0 560 420" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%"   stopColor="#0a1628"/>
        <stop offset="100%" stopColor="#0e2040"/>
      </linearGradient>
      <pattern id="bpGrid" width="30" height="30" patternUnits="userSpaceOnUse">
        <path d="M 30 0 L 0 0 0 30" fill="none" stroke="rgba(6,150,215,0.12)" strokeWidth="0.6"/>
      </pattern>
      <pattern id="bpDot" width="15" height="15" patternUnits="userSpaceOnUse">
        <circle cx="7.5" cy="7.5" r="0.7" fill="rgba(6,150,215,0.20)"/>
      </pattern>
      <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="2.5" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <marker id="arrowFwd" markerWidth="5" markerHeight="5" refX="5" refY="2.5" orient="auto">
        <polygon points="0 0, 5 2.5, 0 5" fill="#0696d7"/>
      </marker>
      <marker id="arrowBck" markerWidth="5" markerHeight="5" refX="0" refY="2.5" orient="auto-start-reverse">
        <polygon points="0 0, 5 2.5, 0 5" fill="#0696d7"/>
      </marker>
    </defs>

    {/* ── Background ── */}
    <rect width="560" height="420" fill="url(#bgGrad)"/>
    <rect width="560" height="420" fill="url(#bpGrid)"/>
    <rect width="560" height="420" fill="url(#bpDot)"/>

    {/* ── Blueprint border frame ── */}
    <rect x="12" y="12" width="536" height="396" fill="none"
          stroke="rgba(6,150,215,0.30)" strokeWidth="1"/>
    <rect x="16" y="16" width="528" height="388" fill="none"
          stroke="rgba(6,150,215,0.15)" strokeWidth="0.5"/>

    {/* ══════════════════════════════════════════
        ISOMETRIC BOX + CYLINDER ASSEMBLY
        Box corners (screen px):
          E(280,195) F(375,250) G(202,240) H(297,295)  ← top face
          A(280,270) B(375,325)                          ← front bottom
          C(297,370)                                     ← right bottom-back
        Cylinder: base≈(289,245) top=(289,155) rx=22 ry=11
       ══════════════════════════════════════════ */}

    {/* Box — Right face */}
    <polygon points="375,250 297,295 297,370 375,325"
             fill="#0d2540" stroke="#0696d7" strokeWidth="1.2"/>

    {/* Box — Front face */}
    <polygon points="280,195 375,250 375,325 280,270"
             fill="#112d4e" stroke="#0696d7" strokeWidth="1.2"/>

    {/* Box — Top face */}
    <polygon points="280,195 375,250 297,295 202,240"
             fill="#1a4070" stroke="#0696d7" strokeWidth="1.4"/>

    {/* Edge highlight — top face edges (glow) */}
    <polyline points="280,195 375,250 297,295 202,240 280,195"
              fill="none" stroke="rgba(6,150,215,0.6)" strokeWidth="0.8"
              filter="url(#glow)"/>

    {/* ── Hole pattern on top face (2 countersunk holes) ── */}
    {/* Hole 1 at ~(240,222) on top face */}
    <ellipse cx="240" cy="222" rx="9" ry="4.5"
             fill="#0a1a2e" stroke="#0696d7" strokeWidth="0.9"/>
    <ellipse cx="240" cy="222" rx="5" ry="2.5"
             fill="#060e1c" stroke="rgba(6,150,215,0.5)" strokeWidth="0.6"/>
    {/* Hole 2 at ~(330,262) */}
    <ellipse cx="330" cy="262" rx="9" ry="4.5"
             fill="#0a1a2e" stroke="#0696d7" strokeWidth="0.9"/>
    <ellipse cx="330" cy="262" rx="5" ry="2.5"
             fill="#060e1c" stroke="rgba(6,150,215,0.5)" strokeWidth="0.6"/>

    {/* ── Cylinder body ── */}
    <polygon points="267,155 311,155 311,245 267,245"
             fill="#112d50" stroke="none"/>
    {/* Cylinder top ellipse */}
    <ellipse cx="289" cy="155" rx="22" ry="11"
             fill="#1a4a80" stroke="#0696d7" strokeWidth="1.4"
             filter="url(#glow)"/>
    {/* Cylinder inner bore */}
    <ellipse cx="289" cy="155" rx="11" ry="5.5"
             fill="#060e1c" stroke="rgba(6,150,215,0.7)" strokeWidth="0.9"/>
    {/* Cylinder side edges */}
    <line x1="267" y1="155" x2="267" y2="245"
          stroke="#0696d7" strokeWidth="1.2"/>
    <line x1="311" y1="155" x2="311" y2="245"
          stroke="#0696d7" strokeWidth="1.2"/>
    {/* Cylinder base ellipse (sitting on top face) */}
    <ellipse cx="289" cy="245" rx="22" ry="11"
             fill="none" stroke="rgba(6,150,215,0.4)" strokeWidth="0.8"
             strokeDasharray="4,3"/>

    {/* Centerline on cylinder (dash-dot) */}
    <line x1="289" y1="130" x2="289" y2="268"
          stroke="rgba(6,150,215,0.4)" strokeWidth="0.7"
          strokeDasharray="8,3,2,3"/>

    {/* ── Dimension line: box width (A→B direction) ── */}
    {/* Extension lines */}
    <line x1="280" y1="270" x2="280" y2="380"
          stroke="rgba(6,150,215,0.5)" strokeWidth="0.7"/>
    <line x1="375" y1="325" x2="375" y2="380"
          stroke="rgba(6,150,215,0.5)" strokeWidth="0.7"/>
    {/* Dimension line with arrows */}
    <line x1="280" y1="376" x2="375" y2="376"
          stroke="#0696d7" strokeWidth="0.9"
          markerStart="url(#arrowBck)" markerEnd="url(#arrowFwd)"/>
    <text x="327" y="392" textAnchor="middle"
          fill="#0696d7" fontSize="9" fontFamily="monospace">110 mm</text>

    {/* ── Dimension line: box height (E→A direction) ── */}
    <line x1="280" y1="195" x2="170" y2="195"
          stroke="rgba(6,150,215,0.5)" strokeWidth="0.7"/>
    <line x1="280" y1="270" x2="170" y2="270"
          stroke="rgba(6,150,215,0.5)" strokeWidth="0.7"/>
    <line x1="174" y1="195" x2="174" y2="270"
          stroke="#0696d7" strokeWidth="0.9"
          markerStart="url(#arrowBck)" markerEnd="url(#arrowFwd)"/>
    <text x="160" y="236" textAnchor="middle"
          fill="#0696d7" fontSize="9" fontFamily="monospace"
          transform="rotate(-90,160,236)">75 mm</text>

    {/* ── Cylinder diameter callout ── */}
    <line x1="311" y1="148" x2="370" y2="130"
          stroke="rgba(6,150,215,0.6)" strokeWidth="0.7"/>
    <line x1="370" y1="130" x2="420" y2="130"
          stroke="rgba(6,150,215,0.6)" strokeWidth="0.7"/>
    <text x="424" y="134" fill="#0696d7" fontSize="9" fontFamily="monospace">⌀44</text>

    {/* ── Coordinate axes (bottom-right) ── */}
    <g transform="translate(490,360)">
      {/* X axis */}
      <line x1="0" y1="0" x2="28" y2="14"
            stroke="#e05a4e" strokeWidth="1.5" markerEnd="url(#arrowFwd)"/>
      <text x="33" y="18" fill="#e05a4e" fontSize="9" fontWeight="bold">X</text>
      {/* Y axis */}
      <line x1="0" y1="0" x2="0" y2="-32"
            stroke="#4ea85a" strokeWidth="1.5" markerEnd="url(#arrowFwd)"/>
      <text x="-5" y="-35" fill="#4ea85a" fontSize="9" fontWeight="bold">Y</text>
      {/* Z axis */}
      <line x1="0" y1="0" x2="-28" y2="14"
            stroke="#4a90d9" strokeWidth="1.5" markerEnd="url(#arrowFwd)"/>
      <text x="-42" y="18" fill="#4a90d9" fontSize="9" fontWeight="bold">Z</text>
      {/* Origin dot */}
      <circle cx="0" cy="0" r="3" fill="#0696d7"/>
    </g>

    {/* ── Section mark on right face ── */}
    <text x="340" y="346" fill="rgba(6,150,215,0.7)"
          fontSize="8" fontFamily="monospace">A-A</text>
    <line x1="297" y1="332" x2="380" y2="350"
          stroke="rgba(6,150,215,0.3)" strokeWidth="0.6"
          strokeDasharray="3,2"/>

    {/* ── Surface finish mark ── */}
    <g transform="translate(378,252)">
      <path d="M0,0 L6,10 L12,0" fill="none"
            stroke="rgba(6,150,215,0.6)" strokeWidth="0.8"/>
      <text x="6" y="-2" textAnchor="middle"
            fill="rgba(6,150,215,0.6)" fontSize="7">Ra1.6</text>
    </g>

    {/* ── Title block (bottom-right) ── */}
    <rect x="390" y="350" width="154" height="50"
          fill="rgba(6,150,215,0.05)" stroke="rgba(6,150,215,0.2)" strokeWidth="0.8"/>
    <line x1="390" y1="364" x2="544" y2="364"
          stroke="rgba(6,150,215,0.2)" strokeWidth="0.6"/>
    <text x="466" y="360" textAnchor="middle"
          fill="rgba(6,150,215,0.5)" fontSize="7" fontFamily="monospace">TOUBKALCAD</text>
    <text x="400" y="374" fill="rgba(6,150,215,0.4)" fontSize="7" fontFamily="monospace">MATERIAL: AL6082</text>
    <text x="400" y="384" fill="rgba(6,150,215,0.4)" fontSize="7" fontFamily="monospace">SCALE: 1:2</text>
    <text x="400" y="394" fill="rgba(6,150,215,0.4)" fontSize="7" fontFamily="monospace">REV: A</text>
  </svg>
);

// ─── Splash screen ────────────────────────────────────────────────────────────
interface LoadingProps { error: string | null; step: string }

const LoadingScreen: React.FC<LoadingProps> = ({ error, step }) => (
  <div style={{
    height: '100vh', width: '100vw',
    background: '#0a1628',
    display: 'flex',
    overflow: 'hidden',
    fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
  }}>
    {/* Left: CAD illustration */}
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      minWidth: 0,
    }}>
      <CADIllustration />
    </div>

    {/* Divider */}
    <div style={{
      width: '1px',
      background: 'linear-gradient(to bottom, transparent, rgba(6,150,215,0.4) 30%, rgba(6,150,215,0.4) 70%, transparent)',
      flexShrink: 0,
    }}/>

    {/* Right: Logo + loading info */}
    <div style={{
      width: '360px',
      flexShrink: 0,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      padding: '50px 44px',
    }}>
      {/* App Logo */}
      <div style={{ marginBottom: '10px' }}>
        <span style={{ fontSize: '38px', fontWeight: 900, letterSpacing: '2px', color: '#0696d7' }}>
          TOUBKAL
        </span>
        <span style={{ fontSize: '38px', fontWeight: 300, letterSpacing: '2px', color: '#c8d4e0' }}>
          CAD
        </span>
      </div>
      <div style={{
        fontSize: '9px', color: '#3a5a7a', letterSpacing: '4px',
        marginBottom: '44px', fontWeight: 500,
      }}>
        PROFESSIONAL 3D CAD PLATFORM
      </div>

      {!error ? (
        <>
          {/* Spinner */}
          <div style={{
            width: '28px', height: '28px',
            border: '2px solid rgba(6,150,215,0.2)',
            borderTop: '2px solid #0696d7',
            borderRadius: '50%',
            animation: 'spin 0.85s linear infinite',
            marginBottom: '18px',
          }}/>

          {/* Loading step */}
          <p style={{
            color: '#4a7a9a', fontSize: '11px',
            marginBottom: '20px', lineHeight: '1.6',
            minHeight: '34px',
          }}>
            {step}
          </p>

          {/* Progress bar */}
          <div style={{
            width: '100%', height: '2px',
            background: 'rgba(6,150,215,0.15)',
            borderRadius: '1px',
            marginBottom: '44px',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%', width: '40%',
              background: 'linear-gradient(90deg, #0578b5, #0696d7, #38b6ff)',
              animation: 'progress-slide 1.4s ease-in-out infinite',
              borderRadius: '1px',
            }}/>
          </div>

          {/* Tech stack badges */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {['OpenCascade WASM', 'Three.js r170', 'React 18', 'Zustand'].map((t) => (
              <span key={t} style={{
                fontSize: '9px', color: '#2a5a7a',
                border: '1px solid rgba(6,150,215,0.2)',
                borderRadius: '2px', padding: '2px 7px',
                background: 'rgba(6,150,215,0.06)',
                letterSpacing: '0.3px',
              }}>
                {t}
              </span>
            ))}
          </div>

          {/* Version */}
          <div style={{
            marginTop: 'auto', paddingTop: '40px',
            fontSize: '10px', color: '#1e3a54',
          }}>
            v2.0 · WebAssembly Powered
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: '22px', marginBottom: '12px', color: '#cf4040' }}>⚠</div>
          <p style={{ color: '#cf4040', fontSize: '12px', marginBottom: '8px', fontWeight: 600 }}>
            Kernel initialization failed
          </p>
          <pre style={{
            background: 'rgba(200,0,0,0.08)',
            color: '#e08080',
            padding: '12px 14px',
            borderRadius: '4px',
            fontSize: '10px',
            whiteSpace: 'pre-wrap',
            border: '1px solid rgba(200,0,0,0.2)',
            marginBottom: '16px',
            maxHeight: '180px',
            overflowY: 'auto',
          }}>
            {error}
          </pre>
          <p style={{ color: '#2a4a6a', fontSize: '10px', lineHeight: '1.7' }}>
            Common causes:<br/>
            • COOP/COEP headers missing (SharedArrayBuffer)<br/>
            • .wasm file not reachable (check Network tab)<br/>
            • Safari private mode
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '20px', padding: '8px 22px',
              background: '#0696d7', color: '#fff',
              border: 'none', borderRadius: '4px',
              cursor: 'pointer', fontSize: '11px', fontWeight: 600,
              alignSelf: 'flex-start',
            }}
          >
            ↺ Reload
          </button>
        </>
      )}
    </div>
  </div>
);

// ─── App initializer ──────────────────────────────────────────────────────────
const AppInitializer: React.FC = () => {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step,  setStep]  = useState('Loading C++/WebAssembly kernel…');

  useEffect(() => {
    const init = async () => {
      try {
        setStep('Initializing OpenCascade.js (loading WASM)…');
        const oc = await initOpenCascade();
        window.oc = oc;

        setStep('Initializing geometry registry…');
        CADGeometryRegistry.getInstance();
        ThreeMeshCache.getInstance();

        setStep('Loading interface…');
        await new Promise<void>((r) => setTimeout(r, 60));
        setReady(true);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[ToubkalCAD] Critical error:', err);
        if (msg.includes('SharedArrayBuffer') || msg.includes('COEP') || msg.includes('COOP')) {
          setError(
            `Cross-origin isolation headers missing.\n\n` +
            `Required:\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n\n` +
            `Original: ${msg}`,
          );
        } else if (msg.includes('fetch') || msg.includes('wasm')) {
          setError(`WASM file not found.\n\nCheck dist/wasm/*.wasm exists.\n\nOriginal: ${msg}`);
        } else {
          setError(msg);
        }
      }
    };
    init();
  }, []);

  if (!ready) return <LoadingScreen error={error} step={step} />;
  return (
    <ErrorBoundary label="Application">
      <CADLayout />
    </ErrorBoundary>
  );
};

// ─── DOM mount ────────────────────────────────────────────────────────────────
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <>
      <AppInitializer />
      <ParameterModal />
    </>,
  );
}
