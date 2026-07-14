/**
 * particle-system: シンプルなCPUパーティクルシステム（THREE.Points）。
 *
 * - 基本の運動は「初速 v0 + 重力 g による等加速度運動」の閉形式で位置を計算する
 *   （position(age) = v0*age + 0.5*g*age^2）。毎フレームの速度積分が不要なため、
 *   粒子の年齢(age)さえ分かれば独立に位置を再計算できる。これを利用して、
 *   起動直後に各粒子の年齢をランダムにずらし「既に稼働中」の見た目にする（loop時）
 * - turbulence > 0 の場合は、多重周波数ノイズ（fBm = fractal Brownian motion。
 *   自己相似なノイズを複数オクターブ重ねる「フラクタルノイズ」）で作った疑似カールノイズ
 *   （3成分を独立にずらしてサンプリングする簡易版。真の非圧縮カールノイズではないが
 *   計算コストが低く視覚的には十分に流体・渦らしい動きになる）で速度場を毎フレーム
 *   揺らす。この場合は閉形式を使わず数値積分（オイラー法）に切り替える
 * - 粒子ごとの個別フェードは行わない（PointsMaterialは全粒子で色/不透明度が共通のため）。
 *   非ループ時に寿命が尽きた粒子はカメラから十分離れた位置へ退避させ、見えなくする
 * - three.js にのみ依存する。ARエンジン(XR8.*)には依存しない
 */
import * as THREE from 'three';

/** components.particleSystem が未設定/不完全でも動くようにする既定値 */
const DEFAULTS = {
  count: 100,
  gravity: [0, -1, 0],
  initialVelocity: [0, 1, 0],
  spread: 0.5,
  lifetime: 2,
  size: 0.05,
  color: '#ffffff',
  loop: true,
  turbulence: 0,
  turbulenceScale: 1,
  turbulenceSpeed: 0.5,
  // エミッター形状（粒子の発生位置。'point'=原点のみ、既定=従来と同一挙動）
  emitterShape: 'point', // 'point' | 'sphere' | 'box' | 'circle' | 'cone'
  emitterRadius: 0.5, // sphere / circle / cone の半径
  emitterSize: [1, 1, 1], // box の各辺の長さ
  emitterConeAngle: 25, // cone の半頂角（度）
  // 初速の向き: 'velocity'=initialVelocityベクトルのまま（既定=従来挙動）
  // 'shape'=形状に沿う（球=中心から外向き、円=XZ外向き、コーン=+Y軸まわりの円錐内、
  //         点/ボックス=initialVelocityの向き。速さは|initialVelocity|）
  emitterDirection: 'velocity', // 'velocity' | 'shape'
};

function withDefaults(settings) {
  return { ...DEFAULTS, ...(settings || {}) };
}

/** 画像の ArrayBuffer からテクスチャを読み込む（粒子画像用） */
export async function loadTexture(arrayBuffer, mime) {
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------- フラクタルノイズ（3D Simplex Noise + fBm） ---------- */

const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];
const F3 = 1 / 3;
const G3 = 1 / 6;

/** シードから決定的な擬似乱数で permutation テーブルを作る（外部ライブラリ非依存） */
function buildPermutation(seed) {
  let s = (seed >>> 0) || 1;
  const rand = () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  return perm;
}

/**
 * 3D Simplex Noise を生成する（Stefan Gustavson のパブリックドメイン実装を移植）。
 * 戻り値はおおむね [-1, 1] の範囲の連続的なノイズ関数。
 */
function makeNoise3D(seed) {
  const perm = buildPermutation(seed);

  function corner(gi, x, y, z) {
    let t = 0.6 - x * x - y * y - z * z;
    if (t < 0) return 0;
    t *= t;
    const g = GRAD3[gi];
    return t * t * (g[0] * x + g[1] * y + g[2] * z);
  }

  return function noise3D(x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ii = i & 255, jj = j & 255, kk = k & 255;
    const gi0 = perm[ii + perm[jj + perm[kk]]] % 12;
    const gi1 = perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] % 12;
    const gi2 = perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] % 12;
    const gi3 = perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] % 12;

    const n0 = corner(gi0, x0, y0, z0);
    const n1 = corner(gi1, x1, y1, z1);
    const n2 = corner(gi2, x2, y2, z2);
    const n3 = corner(gi3, x3, y3, z3);

    return 32 * (n0 + n1 + n2 + n3);
  };
}

const FBM_OCTAVES = 3;
const FBM_LACUNARITY = 2;
const FBM_GAIN = 0.5;

/** 複数オクターブのノイズを重ねる＝フラクタルノイズ（fBm）。概ね[-1, 1]に正規化する */
function fbm3(noise3D, x, y, z) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let maxAmp = 0;
  for (let o = 0; o < FBM_OCTAVES; o++) {
    sum += noise3D(x * frequency, y * frequency, z * frequency) * amplitude;
    maxAmp += amplitude;
    amplitude *= FBM_GAIN;
    frequency *= FBM_LACUNARITY;
  }
  return sum / maxAmp;
}

/**
 * パーティクルシステムを生成する。
 * 戻り値の mixer は AnimationMixer と同じ update(delta) インターフェースを持つため、
 * GLB/Lottieと同じ mixers 配列（createAnimationUpdater）にそのまま乗せられる。
 *
 * @param {object} [rawSettings] ParticleSystemSettings（省略/部分指定可）
 * @param {import('three').Texture|null} [texture] 粒子画像。未指定なら単色の点
 * @returns {{ object: import('three').Points, mixer: { update(delta: number): void } }}
 */
export function createParticleSystem(rawSettings, texture = null) {
  const settings = withDefaults(rawSettings);
  const count = Math.max(1, Math.floor(settings.count) || 1);
  const lifetime = Math.max(0.01, settings.lifetime);
  const [gx, gy, gz] = settings.gravity;
  const [vx0, vy0, vz0] = settings.initialVelocity;
  const baseSpeed = Math.hypot(vx0, vy0, vz0) || 1;
  const jitter = Math.max(0, Math.min(1, settings.spread)) * baseSpeed;
  const loop = settings.loop !== false;

  const turbulence = Math.max(0, settings.turbulence || 0);
  const turbulenceScale = settings.turbulenceScale > 0 ? settings.turbulenceScale : 1;
  const turbulenceSpeed = settings.turbulenceSpeed || 0;
  const useNoise = turbulence > 0;
  const noise3D = useNoise ? makeNoise3D(Math.floor(Math.random() * 0xffffffff)) : null;

  // エミッター形状（発生位置は粒子ごとの定数のため、閉形式運動と両立する）
  const emitterShape = settings.emitterShape || 'point';
  const emitterRadius = Math.max(0, settings.emitterRadius ?? 0.5);
  const [ebx, eby, ebz] = Array.isArray(settings.emitterSize) ? settings.emitterSize : [1, 1, 1];
  const coneAngleRad = THREE.MathUtils.degToRad(
    Math.max(0, Math.min(89, settings.emitterConeAngle ?? 25)),
  );
  const shapeDirection = settings.emitterDirection === 'shape';

  const positions = new Float32Array(count * 3);
  // 閉形式モードでは「初速（固定）」、数値積分モードでは「現在速度（毎フレーム更新）」として使う
  const velocities = new Float32Array(count * 3);
  // 粒子ごとの発生位置（エミッター形状からサンプリング。閉形式の基準点になる）
  const origins = new Float32Array(count * 3);
  const ages = new Float32Array(count);
  const dead = new Uint8Array(count);

  // 非ループ時に寿命が尽きた粒子を退避させる先（カメラから十分離れ、実質不可視）
  const DEAD_Y = -1e6;

  /** エミッター形状から発生位置をサンプリングして origins[i] に書き込む */
  function sampleOrigin(i) {
    let ox = 0;
    let oy = 0;
    let oz = 0;
    switch (emitterShape) {
      case 'sphere': {
        // 球の内部に一様分布（半径方向はcbrtで体積一様に補正）
        const u = Math.random() * 2 - 1;
        const phi = Math.random() * Math.PI * 2;
        const r = emitterRadius * Math.cbrt(Math.random());
        const sq = Math.sqrt(1 - u * u);
        ox = r * sq * Math.cos(phi);
        oy = r * u;
        oz = r * sq * Math.sin(phi);
        break;
      }
      case 'box':
        ox = (Math.random() - 0.5) * ebx;
        oy = (Math.random() - 0.5) * eby;
        oz = (Math.random() - 0.5) * ebz;
        break;
      case 'circle':
      case 'cone': {
        // XZ平面の円盤に一様分布（半径方向はsqrtで面積一様に補正）。コーンは底面円盤
        const ang = Math.random() * Math.PI * 2;
        const r = emitterRadius * Math.sqrt(Math.random());
        ox = r * Math.cos(ang);
        oz = r * Math.sin(ang);
        break;
      }
      default:
        break; // 'point': 原点
    }
    origins[i * 3] = ox;
    origins[i * 3 + 1] = oy;
    origins[i * 3 + 2] = oz;
  }

  function sampleVelocity(i) {
    if (shapeDirection) {
      // 形状に沿った向き × |initialVelocity| を基準にジッターを加える
      let dx = 0;
      let dy = 1;
      let dz = 0;
      const ox = origins[i * 3];
      const oy = origins[i * 3 + 1];
      const oz = origins[i * 3 + 2];
      if (emitterShape === 'sphere') {
        const len = Math.hypot(ox, oy, oz);
        if (len > 1e-6) {
          dx = ox / len;
          dy = oy / len;
          dz = oz / len;
        } else {
          // 中心ちょうどの場合はランダムな方向
          const u = Math.random() * 2 - 1;
          const phi = Math.random() * Math.PI * 2;
          const sq = Math.sqrt(1 - u * u);
          dx = sq * Math.cos(phi);
          dy = u;
          dz = sq * Math.sin(phi);
        }
      } else if (emitterShape === 'circle') {
        const len = Math.hypot(ox, oz);
        if (len > 1e-6) {
          dx = ox / len;
          dy = 0;
          dz = oz / len;
        } else {
          const ang = Math.random() * Math.PI * 2;
          dx = Math.cos(ang);
          dy = 0;
          dz = Math.sin(ang);
        }
      } else if (emitterShape === 'cone') {
        // +Y軸まわりの半頂角 coneAngleRad の円錐内に一様分布
        const cosMax = Math.cos(coneAngleRad);
        const cosT = cosMax + (1 - cosMax) * Math.random();
        const sinT = Math.sqrt(1 - cosT * cosT);
        const phi = Math.random() * Math.PI * 2;
        dx = sinT * Math.cos(phi);
        dy = cosT;
        dz = sinT * Math.sin(phi);
      } else {
        // point / box: initialVelocity の向き（ゼロベクトルなら+Y）
        const len = Math.hypot(vx0, vy0, vz0);
        if (len > 1e-6) {
          dx = vx0 / len;
          dy = vy0 / len;
          dz = vz0 / len;
        }
      }
      velocities[i * 3] = dx * baseSpeed + (Math.random() * 2 - 1) * jitter;
      velocities[i * 3 + 1] = dy * baseSpeed + (Math.random() * 2 - 1) * jitter;
      velocities[i * 3 + 2] = dz * baseSpeed + (Math.random() * 2 - 1) * jitter;
      return;
    }
    velocities[i * 3] = vx0 + (Math.random() * 2 - 1) * jitter;
    velocities[i * 3 + 1] = vy0 + (Math.random() * 2 - 1) * jitter;
    velocities[i * 3 + 2] = vz0 + (Math.random() * 2 - 1) * jitter;
  }

  function writePositionClosed(i, age) {
    positions[i * 3] = origins[i * 3] + velocities[i * 3] * age + 0.5 * gx * age * age;
    positions[i * 3 + 1] =
      origins[i * 3 + 1] + velocities[i * 3 + 1] * age + 0.5 * gy * age * age;
    positions[i * 3 + 2] =
      origins[i * 3 + 2] + velocities[i * 3 + 2] * age + 0.5 * gz * age * age;
  }

  /**
   * 疑似カールノイズ（3軸を独立にオフセットしてfBmをサンプリングした流れ場）。
   * 真の非圧縮（div-free）カールノイズより計算が軽く、視覚的には十分に渦・流体らしい。
   */
  function flowAt(x, y, z, t) {
    const sx = x * turbulenceScale;
    const sy = y * turbulenceScale;
    const sz = z * turbulenceScale + t;
    return [
      fbm3(noise3D, sx, sy, sz),
      fbm3(noise3D, sx + 37.2, sy + 17.1, sz),
      fbm3(noise3D, sx - 91.7, sy - 43.9, sz),
    ];
  }

  /** 数値積分（オイラー法）で1粒子をdt秒ぶん進める（毎フレーム更新・起動時fast-forward共用） */
  function stepParticle(i, dt) {
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
    let vx = velocities[i * 3], vy = velocities[i * 3 + 1], vz = velocities[i * 3 + 2];
    const [fx, fy, fz] = flowAt(px, py, pz, ages[i] * turbulenceSpeed);
    vx += (gx + fx * turbulence) * dt;
    vy += (gy + fy * turbulence) * dt;
    vz += (gz + fz * turbulence) * dt;
    positions[i * 3] = px + vx * dt;
    positions[i * 3 + 1] = py + vy * dt;
    positions[i * 3 + 2] = pz + vz * dt;
    velocities[i * 3] = vx;
    velocities[i * 3 + 1] = vy;
    velocities[i * 3 + 2] = vz;
  }

  function respawn(i) {
    sampleOrigin(i); // 先に発生位置を決める（shape方向モードの初速が参照するため）
    positions[i * 3] = origins[i * 3];
    positions[i * 3 + 1] = origins[i * 3 + 1];
    positions[i * 3 + 2] = origins[i * 3 + 2];
    sampleVelocity(i);
    ages[i] = 0;
    dead[i] = 0;
  }

  // 数値積分モードでは閉形式で「年齢ずらし」を再現できないため、小刻みに積分して早送りする
  const FAST_FORWARD_DT = 1 / 30;

  for (let i = 0; i < count; i++) {
    respawn(i);
    if (loop) {
      const targetAge = Math.random() * lifetime;
      if (useNoise) {
        let t = 0;
        while (t < targetAge) {
          const dt = Math.min(FAST_FORWARD_DT, targetAge - t);
          stepParticle(i, dt);
          ages[i] += dt;
          t += dt;
        }
      } else {
        ages[i] = targetAge;
        writePositionClosed(i, targetAge);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute('position', positionAttr);

  const material = new THREE.PointsMaterial({
    size: Math.max(0.001, settings.size),
    sizeAttenuation: true,
    color: new THREE.Color(settings.color || '#ffffff'),
    transparent: true,
    depthWrite: false,
  });
  if (texture) {
    material.map = texture;
    material.alphaTest = 0.01;
  }

  const points = new THREE.Points(geometry, material);
  points.name = 'particles';
  points.frustumCulled = false; // 粒子が原点から大きく離れてもカリングされないようにする

  const mixer = {
    update(delta) {
      for (let i = 0; i < count; i++) {
        if (dead[i]) continue;
        if (useNoise) {
          stepParticle(i, delta);
          ages[i] += delta;
          if (ages[i] >= lifetime) {
            if (loop) respawn(i);
            else {
              dead[i] = 1;
              positions[i * 3 + 1] = DEAD_Y;
            }
          }
        } else {
          ages[i] += delta;
          if (ages[i] >= lifetime) {
            if (loop) {
              sampleOrigin(i); // 発生位置も取り直す（閉形式はorigins基準で再計算される）
              sampleVelocity(i);
              ages[i] = 0;
            } else {
              dead[i] = 1;
              positions[i * 3 + 1] = DEAD_Y;
              continue;
            }
          }
          writePositionClosed(i, ages[i]);
        }
      }
      positionAttr.needsUpdate = true;
    },
  };

  return { object: points, mixer };
}
