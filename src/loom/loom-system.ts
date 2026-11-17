/**
 * Lumen Loom — seated, hands-only light-weaving puzzle for Meta Quest (WebXR).
 *
 * Interaction model (all with bare hands, inside a two-foot radius):
 *  - Pinch a mirror and TURN YOUR WRIST: the mirror turns with your hand,
 *    clicking through 22.5-degree detents.
 *  - Pinch a loose mirror and LIFT it: carry it to a glowing socket.
 *  - TAP the bead on top of a mirror with one finger: it steps one detent
 *    (the one-finger path for players who cannot pinch or twist).
 *  - Pinch the handle at the near edge to slide the whole loom.
 *  - In mixed reality the loom settles above your real table and every
 *    beam also falls on the table as light; finished puzzles are woven
 *    into a tapestry that stays on that table.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  VisibilityState,
  XRMesh,
  XRPlane,
  createSystem,
} from '@iwsdk/core';
import { LoomAudio } from './audio.js';
import {
  GRID,
  LEVELS,
  LevelDef,
  Piece,
  Segment,
  dailyLevel,
  dateSeed,
  key,
  piecesFromLevel,
  trace,
} from './logic.js';

const S = 0.042; // cell size in metres (whole loom ~38 cm)
const HALF = (GRID - 1) / 2;
const BEAM_Y = 0.024;
const MAX_SEG = 48;
const STORE = 'lumen-loom-v1';
const DETENT = Math.PI / 8;
const TWIST_GAIN = 1.5;
const GRAB_R = 0.05;
const CARRY_START = 0.045;

type Hand = 'left' | 'right';
const HANDS: Hand[] = ['left', 'right'];

interface PieceView {
  piece: Piece;
  root: Group;
  body: Mesh;
  bead: Mesh;
  ring: Mesh;
  homeC: number;
  homeR: number;
  hover: number;
}

interface HandState {
  mode: 'idle' | 'twist' | 'carry' | 'board' | 'next';
  view: PieceView | null;
  startM: number;
  startQ: Quaternion;
  startP: Vector3;
  boardStart: Vector3;
  wasActive: boolean;
  pokeArmed: Map<PieceView, boolean>;
  lastStep: number;
}

interface SaveData {
  level: number;
  woven: Array<{ id: string; segs: number[] }>;
  daily?: string;
}

export class LoomSystem extends createSystem({
  meshes: { required: [XRMesh] },
  planes: { required: [XRPlane] },
}) {
  private audio = new LoomAudio();
  private root!: Group;
  private board!: Group;
  private boardMat!: MeshStandardMaterial;
  private levelGroup!: Group;
  private beamGroup!: Group;
  private beamCore: Mesh[] = [];
  private beamHalo: Mesh[] = [];
  private beamCoreMat!: MeshBasicMaterial;
  private beamHaloMat!: MeshBasicMaterial;
  private floorBeamMat!: MeshBasicMaterial;
  private floorBeams: Mesh[] = [];
  private tableGroup!: Group;
  private tapestry!: Group;
  private tableGlow!: Mesh;
  private hud!: Mesh;
  private hudCanvas!: HTMLCanvasElement;
  private hudTex!: CanvasTexture;
  private hudText = '';
  private nextOrb!: Mesh;
  private handle!: Mesh;

  private levelIndex = 0;
  private level!: LevelDef;
  private pieces: Piece[] = [];
  private views: PieceView[] = [];
  private seedMeshes: Mesh[] = [];
  private seedPools: Mesh[] = [];
  private seedGlowTex!: CanvasTexture;
  private seedGlow: number[] = [];
  private seedTarget: number[] = [];
  private seedWasLit: boolean[] = [];
  private segments: Segment[] = [];
  private solved = false;
  private solvedAt = 0;
  private dirty = true;
  private placed = false;
  private tableY: number | null = null;
  private tableScan = 0;
  private save: SaveData = { level: 0, woven: [] };

  private hands!: Record<Hand, HandState>;
  private tmpV = new Vector3();
  private tmpV2 = new Vector3();
  private tmpQ = new Quaternion();
  private tmpQ2 = new Quaternion();
  private up = new Vector3(0, 1, 0);
  private headPos = new Vector3();
  private headQ = new Quaternion();
  private localP = new Vector3();
  private time = 0;
  private clock = 0;
  private cursorsHidden = false;

  /**
   * Lumen Loom is played by touch and pinch only, so the far-ray cursor that
   * lands on the room behind the loom is noise. Hide it once.
   */
  private hideFarCursors() {
    this.cursorsHidden = true;
    for (const h of HANDS) {
      const mp = this.input.xr.multiPointers[h] as unknown as {
        cursorVisual?: { setVisible: (v: boolean) => void };
      };
      const cv = mp?.cursorVisual;
      if (cv && typeof cv.setVisible === 'function') {
        cv.setVisible(false);
        cv.setVisible = () => {};
      }
      // no far rays at all: every interaction is a touch, pinch or poke
      this.input.xr.multiPointers[h]?.toggleSubPointer('ray', false);
    }
  }

  init(): void {
    this.loadSave();
    this.buildStatic();
    this.hands = {
      left: this.newHandState(),
      right: this.newHandState(),
    };
    this.loadLevel(this.save.level);

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((v) => {
        if (v === VisibilityState.NonImmersive) {
          this.placed = false;
          this.placeForDesktop();
        } else {
          this.audio.resume();
        }
      }),
    );
    // expose a tiny debug surface for automated tests and the trailer rig
    (window as unknown as { __loom?: unknown }).__loom = {
      state: () => ({
        level: this.level.id,
        index: this.levelIndex,
        solved: this.solved,
        lit: this.seedWasLit.slice(),
        pieces: this.pieces.map((p) => ({ ...p })),
        board: this.root.position.toArray(),
        tableY: this.tableY,
      }),
      pieceWorld: (i: number) => {
        const v = this.views[i];
        if (!v) return null;
        v.body.getWorldPosition(this.tmpV);
        const a = this.tmpV.toArray();
        v.bead.getWorldPosition(this.tmpV);
        return { body: a, bead: this.tmpV.toArray() };
      },
      cellWorld: (c: number, r: number) => {
        this.tmpV.set((c - HALF) * S, BEAM_Y, -(r - HALF) * S);
        this.board.localToWorld(this.tmpV);
        return this.tmpV.toArray();
      },
      nextWorld: () => this.nextOrb.getWorldPosition(this.tmpV).toArray(),
      handleWorld: () => this.handle.getWorldPosition(this.tmpV).toArray(),
      meshes: () =>
        Array.from(this.queries.meshes.entities).map((e) => {
          const min = e.getVectorView(XRMesh, 'min');
          const max = e.getVectorView(XRMesh, 'max');
          const o = e.object3D;
          const top = new Vector3((min[0] + max[0]) / 2, max[1], (min[2] + max[2]) / 2);
          if (o) {
            o.updateWorldMatrix(true, false);
            o.localToWorld(top);
          }
          return {
            label: String(e.getValue(XRMesh, 'semanticLabel')),
            top: top.toArray().map((x) => +x.toFixed(3)),
            size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((x) => +x.toFixed(2)),
          };
        }),
      place: () => this.placeForXR(),
      goto: (i: number) => this.loadLevel(i),
      reset: () => {
        this.save = { level: 0, woven: [] };
        this.persist();
        this.rebuildTapestry();
        this.loadLevel(0);
      },
    };
  }

  private newHandState(): HandState {
    return {
      mode: 'idle',
      view: null,
      startM: 0,
      startQ: new Quaternion(),
      startP: new Vector3(),
      boardStart: new Vector3(),
      wasActive: false,
      pokeArmed: new Map(),
      lastStep: 0,
    };
  }

  // ---------------------------------------------------------------- save
  private loadSave() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) this.save = { ...this.save, ...JSON.parse(raw) };
    } catch {
      /* private mode: play without saving */
    }
  }

  private persist() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.save));
    } catch {
      /* ignore */
    }
  }

  // --------------------------------------------------------------- build
  private buildStatic() {
    this.root = new Group();
    this.root.name = 'Lumen Loom';
    this.world.createTransformEntity(this.root, { persistent: true });
    this.board = new Group();
    this.root.add(this.board);

    // glass loom with a printed grid
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const g = canvas.getContext('2d')!;
    const grad = g.createRadialGradient(512, 512, 40, 512, 512, 512);
    grad.addColorStop(0, '#1a2140');
    grad.addColorStop(1, '#070a18');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1024, 1024);
    const radius = 0.255;
    const px = (m: number) => 512 + (m / radius) * 512;
    g.strokeStyle = 'rgba(120,170,255,0.10)';
    g.lineWidth = 2;
    for (let i = 0; i < GRID; i++) {
      const v = (i - HALF) * S;
      g.beginPath();
      g.moveTo(px(-HALF * S), px(v));
      g.lineTo(px(HALF * S), px(v));
      g.stroke();
      g.beginPath();
      g.moveTo(px(v), px(-HALF * S));
      g.lineTo(px(v), px(HALF * S));
      g.stroke();
    }
    g.fillStyle = 'rgba(170,210,255,0.45)';
    for (let c = 0; c < GRID; c++)
      for (let r = 0; r < GRID; r++) {
        g.beginPath();
        g.arc(px((c - HALF) * S), px((r - HALF) * S), 3, 0, Math.PI * 2);
        g.fill();
      }
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    this.boardMat = new MeshStandardMaterial({
      map: tex,
      transparent: true,
      opacity: 0.62,
      roughness: 0.25,
      metalness: 0.2,
    });
    const disc = new Mesh(new CircleGeometry(radius, 96), this.boardMat);
    disc.rotation.x = -Math.PI / 2;
    this.board.add(disc);
    const rim = new Mesh(
      new TorusGeometry(radius, 0.0035, 10, 128),
      new MeshStandardMaterial({
        color: '#9fc7ff',
        emissive: new Color('#3b6cff'),
        emissiveIntensity: 0.9,
        metalness: 0.6,
        roughness: 0.3,
      }),
    );
    rim.rotation.x = Math.PI / 2;
    this.board.add(rim);

    // handle at the near edge to slide the loom
    this.handle = new Mesh(
      new CylinderGeometry(0.008, 0.008, 0.09, 16),
      new MeshStandardMaterial({
        color: '#c8d6ff',
        emissive: new Color('#4b6dff'),
        emissiveIntensity: 0.5,
        roughness: 0.4,
      }),
    );
    this.handle.rotation.z = Math.PI / 2;
    this.handle.position.set(0, 0.012, radius + 0.02);
    this.handle.name = 'Loom Handle';
    this.board.add(this.handle);

    this.levelGroup = new Group();
    this.board.add(this.levelGroup);

    // beams: pooled cylinders, never allocated per frame
    this.beamGroup = new Group();
    this.board.add(this.beamGroup);
    this.beamCoreMat = new MeshBasicMaterial({
      color: '#f2fdff',
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.beamHaloMat = new MeshBasicMaterial({
      color: '#47c8ff',
      transparent: true,
      opacity: 0.34,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const coreGeo = new CylinderGeometry(0.0042, 0.0042, 1, 8, 1, true);
    const haloGeo = new CylinderGeometry(0.017, 0.017, 1, 14, 1, true);
    for (let i = 0; i < MAX_SEG; i++) {
      const c = new Mesh(coreGeo, this.beamCoreMat);
      const h = new Mesh(haloGeo, this.beamHaloMat);
      c.visible = h.visible = false;
      c.renderOrder = h.renderOrder = 5;
      this.beamGroup.add(c, h);
      this.beamCore.push(c);
      this.beamHalo.push(h);
    }

    // the real table: light pool, beam shadows and the woven tapestry
    this.tableGroup = new Group();
    this.root.add(this.tableGroup);
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 256;
    const gg = glowCanvas.getContext('2d')!;
    const rg = gg.createRadialGradient(128, 128, 0, 128, 128, 128);
    rg.addColorStop(0, 'rgba(120,200,255,0.55)');
    rg.addColorStop(0.5, 'rgba(70,120,255,0.18)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    gg.fillStyle = rg;
    gg.fillRect(0, 0, 256, 256);
    const glowTex = new CanvasTexture(glowCanvas);
    const seedCanvas = document.createElement('canvas');
    seedCanvas.width = seedCanvas.height = 128;
    const sg = seedCanvas.getContext('2d')!;
    const sgr = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
    sgr.addColorStop(0, 'rgba(255,236,170,1)');
    sgr.addColorStop(0.35, 'rgba(255,190,90,0.45)');
    sgr.addColorStop(1, 'rgba(0,0,0,0)');
    sg.fillStyle = sgr;
    sg.fillRect(0, 0, 128, 128);
    this.seedGlowTex = new CanvasTexture(seedCanvas);
    this.tableGlow = new Mesh(
      new PlaneGeometry(1.0, 1.0),
      new MeshBasicMaterial({
        map: glowTex,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.tableGlow.rotation.x = -Math.PI / 2;
    this.tableGroup.add(this.tableGlow);
    this.floorBeamMat = new MeshBasicMaterial({
      color: '#7fd8ff',
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    const fbGeo = new PlaneGeometry(1, 1);
    for (let i = 0; i < MAX_SEG; i++) {
      const m = new Mesh(fbGeo, this.floorBeamMat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.tableGroup.add(m);
      this.floorBeams.push(m);
    }
    this.tapestry = new Group();
    this.tableGroup.add(this.tapestry);
    this.rebuildTapestry();

    // HUD plate above the far edge
    this.hudCanvas = document.createElement('canvas');
    this.hudCanvas.width = 1024;
    this.hudCanvas.height = 256;
    this.hudTex = new CanvasTexture(this.hudCanvas);
    this.hudTex.colorSpace = SRGBColorSpace;
    this.hud = new Mesh(
      new PlaneGeometry(0.44, 0.11),
      new MeshBasicMaterial({
        map: this.hudTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.hud.position.set(0, 0.15, -0.25);
    this.root.add(this.hud);

    // "next" orb, appears when the loom is woven
    this.nextOrb = new Mesh(
      new SphereGeometry(0.02, 32, 16),
      new MeshStandardMaterial({
        color: '#ffe9a8',
        emissive: new Color('#ffb83d'),
        emissiveIntensity: 1.6,
        roughness: 0.2,
      }),
    );
    this.nextOrb.name = 'Next Orb';
    this.nextOrb.position.set(0.2, 0.07, 0.17);
    this.nextOrb.visible = false;
    this.root.add(this.nextOrb);

    this.placeForDesktop();
  }

  private placeForDesktop() {
    // flat-screen preview: in front of the default camera
    this.root.position.set(0, 1.05, -0.55);
    this.root.rotation.set(0, 0, 0);
    this.tableY = null;
    this.tableGroup.visible = true;
    this.tableGroup.position.set(0, -0.1 + 0.001, 0);
  }

  // --------------------------------------------------------------- level
  private loadLevel(index: number) {
    for (const hs of Object.values(this.hands ?? {})) {
      hs.mode = 'idle';
      hs.view = null;
      hs.pokeArmed.clear();
    }
    this.levelIndex = index;
    if (index < LEVELS.length) {
      this.level = LEVELS[index];
    } else if (index === LEVELS.length) {
      this.level = dailyLevel(dateSeed(new Date()));
    } else {
      this.level = dailyLevel(Math.floor(Math.random() * 1e9));
      this.level.title = 'Free Weave';
      this.level.hint = 'Endless looms, made for you';
    }
    this.save.level = index;
    this.persist();

    // clear previous level meshes
    for (const child of [...this.levelGroup.children]) {
      this.levelGroup.remove(child);
      child.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mat = m.material as MeshStandardMaterial;
          mat.dispose();
        }
      });
    }
    this.views = [];
    this.seedMeshes = [];
    this.seedPools = [];
    this.pieces = piecesFromLevel(this.level);

    const lv = this.level;
    // sockets (empty) and socket rings under movable pieces
    const socketCells = [
      ...lv.sockets,
      ...lv.pieces.filter((p) => p.movable).map((p) => p.cell),
    ];
    for (const [c, r] of socketCells) {
      const ring = new Mesh(
        new RingGeometry(0.014, 0.019, 40),
        new MeshBasicMaterial({
          color: '#8fe3ff',
          transparent: true,
          opacity: 0.55,
          side: DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set((c - HALF) * S, 0.002, -(r - HALF) * S);
      this.levelGroup.add(ring);
    }

    // source lantern
    const [sc, sr] = lv.source.cell;
    const src = new Mesh(
      new ConeGeometry(0.012, 0.03, 4),
      new MeshStandardMaterial({
        color: '#ffffff',
        emissive: new Color('#bdf3ff'),
        emissiveIntensity: 2.2,
      }),
    );
    src.position.set((sc - HALF) * S, BEAM_Y, -(sr - HALF) * S);
    src.rotation.z = -Math.PI / 2;
    const srcPivot = new Group();
    srcPivot.position.copy(src.position);
    src.position.set(0, 0, 0);
    srcPivot.add(src);
    srcPivot.rotation.y = (lv.source.dir * Math.PI) / 4;
    this.levelGroup.add(srcPivot);
    const srcBase = new Mesh(
      new CylinderGeometry(0.016, 0.02, 0.012, 24),
      new MeshStandardMaterial({ color: '#30385c', metalness: 0.7, roughness: 0.3 }),
    );
    srcBase.position.set((sc - HALF) * S, 0.006, -(sr - HALF) * S);
    this.levelGroup.add(srcBase);

    // stones
    for (const [c, r] of lv.stones) {
      const st = new Mesh(
        new DodecahedronGeometry(0.016),
        new MeshStandardMaterial({ color: '#3a3a46', roughness: 0.9 }),
      );
      st.position.set((c - HALF) * S, 0.016, -(r - HALF) * S);
      st.rotation.set(c * 0.7, r * 1.3, 0.4);
      this.levelGroup.add(st);
    }

    // seeds
    lv.seeds.forEach((sd) => {
      const mesh = new Mesh(
        new OctahedronGeometry(sd.twin ? 0.021 : 0.017),
        new MeshStandardMaterial({
          color: '#7d7a99',
          emissive: new Color('#ffcf6b'),
          emissiveIntensity: 0.05,
          roughness: 0.25,
          metalness: 0.1,
          flatShading: true,
        }),
      );
      mesh.scale.set(1, 1.7, 1);
      mesh.position.set(
        (sd.cell[0] - HALF) * S,
        BEAM_Y + 0.004,
        -(sd.cell[1] - HALF) * S,
      );
      if (sd.twin) {
        const halo = new Mesh(
          new TorusGeometry(0.024, 0.0018, 8, 48),
          new MeshBasicMaterial({ color: '#ffcf6b', transparent: true, opacity: 0.5 }),
        );
        halo.rotation.x = Math.PI / 2;
        halo.position.copy(mesh.position);
        this.levelGroup.add(halo);
      }
      this.levelGroup.add(mesh);
      this.seedMeshes.push(mesh);
      const pool = new Mesh(
        new PlaneGeometry(0.11, 0.11),
        new MeshBasicMaterial({
          map: this.seedGlowTex,
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(mesh.position.x, 0.003, mesh.position.z);
      this.levelGroup.add(pool);
      this.seedPools.push(pool);
    });
    this.seedGlow = lv.seeds.map(() => 0);
    this.seedTarget = lv.seeds.map(() => 0);
    this.seedWasLit = lv.seeds.map(() => false);

    // pieces
    this.pieces.forEach((p, i) => {
      const root = new Group();
      const isSplit = p.kind === 'splitter';
      const body = new Mesh(
        new BoxGeometry(0.044, 0.032, isSplit ? 0.007 : 0.0045),
        new MeshStandardMaterial({
          color: isSplit ? '#9ff5ff' : '#e6ecff',
          emissive: new Color(isSplit ? '#1aa6c9' : '#5a4dff'),
          emissiveIntensity: 0.25,
          metalness: isSplit ? 0.1 : 1,
          roughness: isSplit ? 0.05 : 0.12,
          transparent: isSplit,
          opacity: isSplit ? 0.6 : 1,
        }),
      );
      body.position.y = BEAM_Y;
      body.name = `${isSplit ? 'Prism' : 'Mirror'} ${i + 1}`;
      const post = new Mesh(
        new CylinderGeometry(0.004, 0.004, 0.024, 10),
        new MeshStandardMaterial({ color: '#5d6690', metalness: 0.8, roughness: 0.3 }),
      );
      post.position.y = BEAM_Y + 0.028;
      const bead = new Mesh(
        new SphereGeometry(0.0075, 20, 12),
        new MeshStandardMaterial({
          color: '#ffffff',
          emissive: new Color(isSplit ? '#53e0ff' : '#9b8cff'),
          emissiveIntensity: 1.2,
        }),
      );
      bead.position.y = BEAM_Y + 0.044;
      bead.name = `${body.name} Bead`;
      const base = new Mesh(
        new CylinderGeometry(0.02, 0.022, 0.006, 32),
        new MeshStandardMaterial({ color: '#262d4d', metalness: 0.6, roughness: 0.35 }),
      );
      base.position.y = 0.003;
      const ring = new Mesh(
        new RingGeometry(0.024, 0.029, 48),
        new MeshBasicMaterial({
          color: '#ffffff',
          transparent: true,
          opacity: 0,
          side: DoubleSide,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.004;
      const spin = new Group();
      spin.add(body);
      root.add(base, ring, spin, post, bead);
      this.levelGroup.add(root);
      const view: PieceView = {
        piece: p,
        root,
        body,
        bead,
        ring,
        homeC: p.c,
        homeR: p.r,
        hover: 0,
      };
      this.views.push(view);
      this.placeView(view);
    });

    this.solved = false;
    this.nextOrb.visible = false;
    this.dirty = true;
    this.setHud(lv.title, lv.hint);
  }

  private placeView(v: PieceView) {
    v.root.position.set((v.piece.c - HALF) * S, 0, -(v.piece.r - HALF) * S);
    (v.body.parent as Group).rotation.y = v.piece.m * DETENT;
  }

  // ----------------------------------------------------------------- HUD
  private setHud(title: string, hint: string) {
    const text = `${title}|${hint}`;
    if (text === this.hudText) return;
    this.hudText = text;
    const g = this.hudCanvas.getContext('2d')!;
    g.clearRect(0, 0, 1024, 256);
    g.fillStyle = 'rgba(8,12,30,0.62)';
    const w = 1000;
    const h = 220;
    const x = 12;
    const y = 18;
    const rr = 40;
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.fill();
    g.textAlign = 'center';
    g.fillStyle = '#fff4d6';
    g.font = '600 76px Georgia, serif';
    g.fillText(title, 512, 112);
    g.fillStyle = '#b9d6ff';
    g.font = '400 46px "Segoe UI", Roboto, sans-serif';
    g.fillText(hint, 512, 190);
    this.hudTex.needsUpdate = true;
  }

  // ------------------------------------------------------------- tapestry
  private rebuildTapestry() {
    for (const child of [...this.tapestry.children]) {
      this.tapestry.remove(child);
      (child as Mesh).geometry?.dispose();
    }
    const mat = new MeshBasicMaterial({
      color: '#ffcf6b',
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    const geo = new PlaneGeometry(1, 1);
    this.save.woven.forEach((w, wi) => {
      const turn = new Group();
      turn.rotation.y = wi * 0.61;
      const sc = 1.45 + 0.12 * (wi % 4);
      turn.scale.setScalar(sc);
      for (let i = 0; i + 3 < w.segs.length; i += 4) {
        const ax = (w.segs[i] - HALF) * S;
        const az = -(w.segs[i + 1] - HALF) * S;
        const bx = (w.segs[i + 2] - HALF) * S;
        const bz = -(w.segs[i + 3] - HALF) * S;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-4) continue;
        const m = new Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set((ax + bx) / 2, 0.001 + wi * 0.0002, (az + bz) / 2);
        m.rotation.z = Math.atan2(-(bz - az), bx - ax);
        m.scale.set(len, 0.0046, 1);
        turn.add(m);
      }
      this.tapestry.add(turn);
    });
  }

  // ------------------------------------------------------------- placing
  private placeForXR() {
    this.player.head.getWorldPosition(this.headPos);
    this.player.head.getWorldQuaternion(this.headQ);
    const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(this.headQ);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.root.rotation.set(0, yaw, 0);
    this.root.position.set(
      this.headPos.x + fwd.x * 0.44,
      this.headPos.y - 0.4,
      this.headPos.z + fwd.z * 0.44,
    );
    this.placed = true;
    this.tableY = null;
    this.tableScan = 0;
    this.tableGroup.visible = true;
    this.tableGroup.position.set(0, -0.1 + 0.001, 0);
  }

  /** Find a real horizontal surface (table, desk) under the loom. */
  private scanTable() {
    const bx = this.root.position.x;
    const bz = this.root.position.z;
    const by = this.root.position.y;
    let best: number | null = null;
    for (const e of this.queries.meshes.entities) {
      const label = String(e.getValue(XRMesh, 'semanticLabel') ?? '').toLowerCase();
      if (!/table|desk|counter/.test(label)) continue;
      const obj = e.object3D;
      if (!obj) continue;
      const min = e.getVectorView(XRMesh, 'min');
      const max = e.getVectorView(XRMesh, 'max');
      obj.updateWorldMatrix(true, false);
      // world-space footprint of the bounded box (4 top corners)
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      let top = -Infinity;
      for (let i = 0; i < 4; i++) {
        this.tmpV2.set(i & 1 ? max[0] : min[0], max[1], i & 2 ? max[2] : min[2]);
        obj.localToWorld(this.tmpV2);
        x0 = Math.min(x0, this.tmpV2.x);
        x1 = Math.max(x1, this.tmpV2.x);
        z0 = Math.min(z0, this.tmpV2.z);
        z1 = Math.max(z1, this.tmpV2.z);
        top = Math.max(top, this.tmpV2.y);
      }
      const pad = 0.12;
      if (bx < x0 - pad || bx > x1 + pad || bz < z0 - pad || bz > z1 + pad) continue;
      if (top < by - 0.6 || top > by + 0.05) continue;
      if (best === null || top > best) best = top;
    }
    if (best === null) {
      for (const e of this.queries.planes.entities) {
        const plane = e.getValue(XRPlane, '_plane') as unknown;
        const orient = (plane as unknown as { orientation?: string })?.orientation;
        if (orient && orient !== 'horizontal') continue;
        const obj = e.object3D;
        if (!obj) continue;
        obj.getWorldPosition(this.tmpV2);
        const top = this.tmpV2.y;
        if (top < 0.35) continue; // floor
        if (top < by - 0.6 || top > by + 0.05) continue;
        if (Math.hypot(this.tmpV2.x - bx, this.tmpV2.z - bz) > 1.2) continue;
        if (best === null || top > best) best = top;
      }
    }
    if (best !== null) {
      this.tableY = best;
      this.root.position.y = best + 0.1;
      this.tableGroup.visible = true;
      this.tableGroup.position.set(0, -0.1 + 0.001, 0);
    }
  }

  // --------------------------------------------------------------- update
  update(rawDelta: number): void {
    // capture rig can slow the loom's clock to record smooth footage
    const scale = (window as unknown as { __loomTimeScale?: number }).__loomTimeScale ?? 1;
    const delta = rawDelta * scale;
    this.clock += delta;
    const time = this.clock;
    this.time = time;
    if (!this.cursorsHidden) this.hideFarCursors();
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    if (immersive && !this.placed) this.placeForXR();
    if (immersive && this.placed && this.tableY === null) {
      this.tableScan -= delta;
      if (this.tableScan <= 0) {
        this.tableScan = 0.5;
        this.scanTable();
      }
    }

    if (immersive) {
      for (const h of HANDS) this.updateHand(h, time);
    }

    if (this.dirty) {
      this.dirty = false;
      this.retrace();
    }

    // animate seeds, beams, hover rings, orb
    const pulse = 0.85 + 0.15 * Math.sin(time * 6);
    this.beamCoreMat.opacity = 0.9 * pulse + 0.1;
    this.beamHaloMat.opacity = 0.46 + 0.1 * Math.sin(time * 3.1);
    for (let i = 0; i < this.seedMeshes.length; i++) {
      this.seedGlow[i] += (this.seedTarget[i] - this.seedGlow[i]) * Math.min(1, delta * 6);
      const g = this.seedGlow[i];
      const m = this.seedMeshes[i];
      const mat = m.material as MeshStandardMaterial;
      mat.emissiveIntensity = 0.05 + g * 2.4;
      mat.color.setRGB(0.49 + g * 0.5, 0.48 + g * 0.35, 0.6 - g * 0.2);
      const s = 1 + g * 0.35;
      m.scale.set(s, 1.7 * s, s);
      m.rotation.y += delta * (0.3 + g * 1.8);
      const pool = this.seedPools[i];
      if (pool) {
        (pool.material as MeshBasicMaterial).opacity = g * (0.85 + 0.15 * Math.sin(time * 5 + i));
        pool.scale.setScalar(0.6 + g * 0.6);
      }
    }
    for (const v of this.views) {
      const mat = v.ring.material as MeshBasicMaterial;
      mat.opacity += (v.hover * 0.85 - mat.opacity) * Math.min(1, delta * 12);
      v.hover = 0;
    }
    if (this.nextOrb.visible) {
      const s = 1 + 0.12 * Math.sin(time * 4);
      this.nextOrb.scale.setScalar(s);
    }
    if (this.tableGroup.visible) {
      const lit = this.seedTarget.reduce((a, b) => a + b, 0);
      const mat = this.tableGlow.material as MeshBasicMaterial;
      mat.opacity = 0.35 + 0.25 * (lit / Math.max(1, this.seedTarget.length));
    }
    // HUD faces the player
    if (immersive) {
      this.player.head.getWorldPosition(this.headPos);
      this.hud.getWorldPosition(this.tmpV);
      const yaw = Math.atan2(this.headPos.x - this.tmpV.x, this.headPos.z - this.tmpV.z);
      this.hud.rotation.set(0, yaw - this.root.rotation.y, 0);
    }
  }

  private retrace() {
    const res = trace(this.level, this.pieces);
    this.segments = res.segments;
    // beams
    for (let i = 0; i < MAX_SEG; i++) {
      const seg = res.segments[i];
      const core = this.beamCore[i];
      const halo = this.beamHalo[i];
      const fb = this.floorBeams[i];
      if (!seg) {
        core.visible = halo.visible = fb.visible = false;
        continue;
      }
      const ax = (seg.from[0] - HALF) * S;
      const az = -(seg.from[1] - HALF) * S;
      const bx = (seg.to[0] - HALF) * S;
      const bz = -(seg.to[1] - HALF) * S;
      const len = Math.hypot(bx - ax, bz - az);
      for (const m of [core, halo]) {
        m.visible = true;
        m.position.set((ax + bx) / 2, BEAM_Y, (az + bz) / 2);
        m.rotation.set(0, 0, 0);
        // cylinder axis is Y: lay it down, then aim it
        m.rotation.z = Math.PI / 2;
        m.rotation.y = Math.atan2(-(bz - az), bx - ax);
        m.rotation.order = 'YZX';
        m.scale.set(1, len, 1);
      }
      fb.visible = true;
      fb.position.set((ax + bx) / 2, 0.002, (az + bz) / 2);
      fb.rotation.set(-Math.PI / 2, 0, Math.atan2(-(bz - az), bx - ax));
      fb.scale.set(len, 0.006, 1);
    }
    // seeds
    let newlyLit = -1;
    res.litSeeds.forEach((lit, i) => {
      const sd = this.level.seeds[i];
      if (sd.twin && !lit) {
        // half bloom when one of the two beams arrives
        const [c, r] = sd.cell;
        const touches = res.segments.some((s) => this.segmentTouches(s, c, r));
        this.seedTarget[i] = touches ? 0.35 : 0;
      } else {
        this.seedTarget[i] = lit ? 1 : 0;
      }
      if (lit && !this.seedWasLit[i]) newlyLit = i;
      this.seedWasLit[i] = lit;
    });
    if (newlyLit >= 0) {
      const c = this.level.seeds[newlyLit].cell[0];
      this.audio.bloom(newlyLit + this.levelIndex, (c - HALF) / HALF);
    }
    if (res.solved && !this.solved) this.onSolved();
  }

  private segmentTouches(s: Segment, c: number, r: number) {
    const ax = s.from[0];
    const ay = s.from[1];
    const bx = s.to[0];
    const by = s.to[1];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return false;
    const t = ((c - ax) * dx + (r - ay) * dy) / (L * L);
    if (t < 0 || t > 1) return false;
    const px = ax + dx * t;
    const py = ay + dy * t;
    return Math.hypot(px - c, py - r) < 0.2;
  }

  private onSolved() {
    this.solved = true;
    this.solvedAt = this.time;
    this.audio.woven();
    const segs: number[] = [];
    for (const s of this.segments) segs.push(s.from[0], s.from[1], s.to[0], s.to[1]);
    if (!this.save.woven.some((w) => w.id === this.level.id)) {
      this.save.woven.push({ id: this.level.id, segs });
      if (this.save.woven.length > 40) this.save.woven.shift();
      this.persist();
      this.rebuildTapestry();
    }
    const count = this.save.woven.length;
    const tail =
      this.levelIndex === LEVELS.length
        ? 'Woven. A new loom waits tomorrow'
        : `Woven into your tapestry (${count})`;
    this.setHud(this.level.title, tail);
    this.nextOrb.visible = true;
  }

  // ---------------------------------------------------------------- hands
  private pinchPoint(h: Hand, out: Vector3) {
    const tip = this.player.indexTipSpaces[h];
    tip.getWorldPosition(out);
    if (out.lengthSq() < 1e-8) this.player.gripSpaces[h].getWorldPosition(out);
    return out;
  }

  private nearestView(p: Vector3, maxD: number): PieceView | null {
    let best: PieceView | null = null;
    let bestD = maxD;
    for (const v of this.views) {
      v.body.getWorldPosition(this.tmpV2);
      const d = this.tmpV2.distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  private twistAngle(h: Hand, hs: HandState) {
    this.player.gripSpaces[h].getWorldQuaternion(this.tmpQ);
    // relative rotation since the pinch began
    this.tmpQ2.copy(hs.startQ).invert();
    this.tmpQ.multiply(this.tmpQ2);
    // swing-twist: keep only the rotation about world up
    const dot = this.tmpQ.x * this.up.x + this.tmpQ.y * this.up.y + this.tmpQ.z * this.up.z;
    let a = 2 * Math.atan2(dot, this.tmpQ.w);
    if (a > Math.PI) a -= Math.PI * 2;
    if (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  private updateHand(h: Hand, time: number) {
    const hs = this.hands[h];
    const sel = this.input.xr.getSelectState(h);
    const active = sel.active;
    const started = active && !hs.wasActive;
    const ended = !active && hs.wasActive;
    hs.wasActive = active;
    const p = this.pinchPoint(h, this.localP);

    // hover feedback
    const hv = this.nearestView(p, GRAB_R);
    if (hv) hv.hover = Math.max(hv.hover, 0.6);

    if (started) {
      this.audio.resume();
      // next orb
      if (this.nextOrb.visible) {
        this.nextOrb.getWorldPosition(this.tmpV);
        if (this.tmpV.distanceTo(p) < 0.06) {
          this.audio.step();
          this.loadLevel(this.levelIndex + 1);
          return;
        }
      }
      // board handle
      this.handle.getWorldPosition(this.tmpV);
      if (this.tmpV.distanceTo(p) < 0.05) {
        hs.mode = 'board';
        hs.startP.copy(p);
        hs.boardStart.copy(this.root.position);
        this.audio.pick();
        return;
      }
      const v = this.nearestView(p, GRAB_R);
      if (v && this.hands[h === 'left' ? 'right' : 'left'].view !== v) {
        hs.mode = 'twist';
        hs.view = v;
        hs.startM = v.piece.m;
        hs.startP.copy(p);
        this.player.gripSpaces[h].getWorldQuaternion(hs.startQ);
        this.audio.pick();
      }
    }

    if (ended) {
      if (hs.mode === 'carry' && hs.view) this.dropCarried(hs.view);
      else if (hs.mode === 'twist') this.audio.drop();
      hs.mode = 'idle';
      hs.view = null;
    }

    if (active && hs.mode === 'board') {
      this.tmpV.copy(p).sub(hs.startP);
      this.root.position.set(
        hs.boardStart.x + this.tmpV.x,
        this.tableY !== null ? this.root.position.y : hs.boardStart.y + this.tmpV.y,
        hs.boardStart.z + this.tmpV.z,
      );
      if (this.tableY !== null) this.root.position.y = this.tableY + 0.1;
    }

    if (active && hs.view && (hs.mode === 'twist' || hs.mode === 'carry')) {
      const v = hs.view;
      v.hover = 1;
      // decide carry vs twist from horizontal travel
      this.tmpV.copy(p).sub(hs.startP);
      this.tmpV.y *= 0.5;
      if (hs.mode === 'twist' && v.piece.movable && this.tmpV.length() > CARRY_START) {
        hs.mode = 'carry';
        this.audio.pick();
      }
      if (hs.mode === 'twist') {
        const a = this.twistAngle(h, hs);
        const steps = Math.round((a * TWIST_GAIN) / DETENT);
        const m = (((hs.startM + steps) % 8) + 8) % 8;
        if (m !== v.piece.m) {
          v.piece.m = m;
          this.placeView(v);
          this.audio.tick(m);
          this.dirty = true;
        }
      } else {
        // carry: follow the pinch in loom space, lifted a little
        this.board.worldToLocal(this.tmpV.copy(p));
        v.root.position.set(this.tmpV.x, Math.max(0.01, this.tmpV.y - BEAM_Y), this.tmpV.z);
        if (v.piece.c !== -99) {
          v.piece.c = -99; // lifted: out of the light
          v.piece.r = -99;
          this.dirty = true;
        }
      }
    }

    // poke-to-step on the bead (one-finger path), only with an open hand
    if (!active && hs.mode === 'idle') {
      for (const v of this.views) {
        v.bead.getWorldPosition(this.tmpV);
        const d = this.tmpV.distanceTo(p);
        const armed = hs.pokeArmed.get(v) ?? true;
        if (armed && d < 0.014 && time - hs.lastStep > 0.25) {
          v.piece.m = (v.piece.m + 1) % 8;
          this.placeView(v);
          this.audio.tick(v.piece.m);
          this.audio.step();
          this.dirty = true;
          hs.lastStep = time;
          hs.pokeArmed.set(v, false);
        } else if (!armed && d > 0.03) {
          hs.pokeArmed.set(v, true);
        }
      }
      // poke the next orb too
      if (this.nextOrb.visible && time - this.solvedAt > 0.8) {
        this.nextOrb.getWorldPosition(this.tmpV);
        if (this.tmpV.distanceTo(p) < 0.025) {
          this.audio.step();
          this.loadLevel(this.levelIndex + 1);
        }
      }
    }
  }

  private dropCarried(v: PieceView) {
    // nearest free socket (or home)
    const cells: Array<[number, number]> = [
      ...this.level.sockets.map((s) => [s[0], s[1]] as [number, number]),
      [v.homeC, v.homeR],
    ];
    const occupied = new Set(
      this.pieces.filter((pc) => pc !== v.piece).map((pc) => key(pc.c, pc.r)),
    );
    const lx = v.root.position.x;
    const lz = v.root.position.z;
    let best: [number, number] = [v.homeC, v.homeR];
    let bestD = 0.06;
    let found = false;
    for (const [c, r] of cells) {
      if (occupied.has(key(c, r))) continue;
      const d = Math.hypot((c - HALF) * S - lx, -(r - HALF) * S - lz);
      if (d < bestD) {
        bestD = d;
        best = [c, r];
        found = true;
      }
    }
    if (!found) {
      // fall back to the closest free socket anywhere, so nothing is ever lost
      let bd = Infinity;
      for (const [c, r] of cells) {
        if (occupied.has(key(c, r))) continue;
        const d = Math.hypot((c - HALF) * S - lx, -(r - HALF) * S - lz);
        if (d < bd) {
          bd = d;
          best = [c, r];
        }
      }
    }
    v.piece.c = best[0];
    v.piece.r = best[1];
    this.placeView(v);
    this.audio.drop();
    this.dirty = true;
  }
}
