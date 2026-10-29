#!/usr/bin/env python3
"""Reproducible ZUNO gift-catalog generator.

Produces >=100 distinct original gift entries with STABLE ids, prices, categories
and a validated asset manifest. Each gift gets:
  - a procedural 3D geometry spec (JSON) the Three.js renderer builds at runtime
    (the brief explicitly permits generated procedural geometry),
  - a DISTINCT procedural audio asset (WAV) for gifts that require sound,
    synthesised with per-gift parameters so no two sounds are identical;
    gifts whose sound is not yet designed are marked 'unresolved' honestly.

Run:  python3 scripts/generate_gifts.py
Outputs (paths relative to repo root):
  packages/gift-engine/data/gifts.json
  assets/3d-models/<id>.geometry.json
  assets/gift-audio/<id>.wav              (sound-bearing gifts only)
  assets/manifests/gift-manifest.json
"""
import json, os, math, struct, hashlib, wave, random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'packages', 'gift-engine', 'data')
MODELS = os.path.join(ROOT, 'assets', '3d-models')
AUDIO = os.path.join(ROOT, 'assets', 'gift-audio')
MANIFEST = os.path.join(ROOT, 'assets', 'manifests')
for d in (DATA, MODELS, AUDIO, MANIFEST):
    os.makedirs(d, exist_ok=True)

# (category_key, human category, [ (name, tier) ... ]) ; tier drives price + fx.
# Tiers: 1 common .. 8 ultimate. Jamaican cultural themes are respectful, not stereotyped.
CATEGORIES = {
    'flowers_romance': ('Flowers & Romance', [
        ('Single Rose',1),('Rose Bouquet',2),('Hibiscus Bloom',2),('Orchid Spray',3),
        ('Heart Petals',3),('Eternal Rose',5),('Love Constellation',6),('Diamond Heart',7),
        ('Lily Basket',2),('Sunflower Field',3)]),
    'celebration': ('Celebrations & Milestones', [
        ('Confetti Pop',1),('Balloon Bunch',2),('Birthday Cake',3),('Fireworks Burst',4),
        ('Golden Trophy',5),('Champagne Tower',5),('Grand Parade',7),
        ('Streamer Cannon',2),('Medal Ceremony',4)]),
    'animals_fantasy': ('Animals & Fantasy Creatures', [
        ('Hummingbird',2),('Doctor Bird',3),('Sea Turtle',3),('Mongoose Dash',2),
        ('Phoenix Rise',6),('Crystal Dragon',7),('Spirit Lion',6),('Celestial Whale',7)]),
    'vehicles': ('Vehicles & Futuristic Machines', [
        ('Scooter',2),('Sports Car',4),('Yacht',6),('Private Jet',7),
        ('Hover Bike',5),('Mag-Lev Pod',6),('Orbital Shuttle',8)]),
    'music_perf': ('Music & Performance', [
        ('Microphone',2),('Vinyl Spin',3),('Sound System',4),('Brass Section',4),
        ('Festival Stage',6),('Neon DJ Deck',5),('Golden Mic',7)]),
    'jamaica_culture': ('Jamaican Cultural Themes', [
        ('Ackee & Saltfish',2),('Steel Drum',3),('Bamboo Raft',3),('Blue Mountain Peak',4),
        ('Reggae Sunsplash',5),('Market Basket',2),('Festival Kite',3)]),
    'jamaica_parish': ('Jamaican Parish Pride', [
        ('Kingston',3),('St. Andrew',3),('Portland',3),('St. Ann',3),('Montego Bay',4),
        ('Clarendon',3),('Manchester',3),('St. Elizabeth',3),('Westmoreland',3),
        ('Trelawny',3),('St. Mary',3),('St. Thomas',3),('Hanover',3),('St. Catherine',3)]),
    'luxury': ('Royal, Luxury & Prestige', [
        ('Gold Ring',4),('Crown Jewel',6),('Royal Crown',7),('Emerald Scepter',6),
        ('Platinum Watch',5),('Palace Gates',7),('Sovereign Throne',8)]),
    'cosmic': ('Space, Cosmic & Universe', [
        ('Shooting Star',3),('Saturn Ring',5),('Galaxy Swirl',6),('Supernova',7),
        ('Black Hole',7),('Nebula Veil',6),('Ultimate Universe',8),
        ('Comet Trail',4),('Star Cluster',5),('Wormhole',6)]),
    'seasonal': ('Seasonal & Event', [
        ('Snowflake',2),('Pumpkin Glow',3),('Spring Blossom',2),('Summer Sun',3),
        ('New Year Bell',4),('Harvest Moon',4),('Fireflies',3),('Lantern Float',4),('Cherry Blossom Rain',5)]),
    'creator_support': ('Creator Support', [
        ('Thumbs Up',1),('Coffee Cup',1),('Fan Badge',2),('Super Fan',4),
        ('Patron Medal',5),('Legend Banner',6),('Rocket Boost',3),('Spotlight',4),('Hall of Fame',6)]),
    'premium_animated': ('Premium Animated', [
        ('Aurora Wings',6),('Prism Fountain',6),('Infinity Bloom',7),
        ('Starfall Carousel',7),('Celestial Crown',8),('Eternal Phoenix',8)]),
}

# price = base * tier multiplier (server-authoritative; client never sets price)
TIER_PRICE = {1:5,2:20,3:99,4:299,5:999,6:2999,7:9999,8:50000}
TIER_FX = {1:'pop',2:'sparkle',3:'burst',4:'orbit',5:'particles',6:'cinematic',7:'fullscreen',8:'universe'}
# Which tiers carry a bespoke sound.
SOUND_TIERS = {4,5,6,7,8}

def slug(name):
    return ''.join(c if c.isalnum() else '_' for c in name.lower()).strip('_')

def gift_id(cat_key, name):
    # Stable id derived from category+name; survives price/asset/name-display changes
    h = hashlib.sha1(f'{cat_key}:{slug(name)}'.encode()).hexdigest()[:8]
    return f'gift_{cat_key}_{slug(name)}_{h}'[:72]

def geometry_spec(gid, tier, cat_key):
    rnd = random.Random(gid)
    shapes = ['sphere','box','cone','torus','icosahedron','cylinder','tetrahedron']
    palette = [rnd.randint(0x202020,0xffffff) for _ in range(3)]
    parts = []
    for i in range(2 + tier // 2):
        parts.append({
            'shape': rnd.choice(shapes),
            'scale': round(0.4 + rnd.random()*1.4, 3),
            'color': f'#{palette[i % len(palette)]:06x}',
            'metalness': round(0.2 + (tier/10.0), 3),
            'roughness': round(max(0.05, 0.9 - tier*0.1), 3),
            'position': [round(rnd.uniform(-1,1),3) for _ in range(3)],
        })
    return {
        'giftId': gid,
        'renderer': 'three.js',
        'format': 'procedural-geometry-spec-v1',
        'parts': parts,
        'animation': {'spin': True, 'bob': tier>=3, 'particles': tier>=5, 'durationMs': 1500 + tier*400},
        'lighting': {'ambient': 0.6, 'key': 1.0, 'rim': 0.4 + tier*0.05},
    }

def synth_wav(path, gid):
    """Distinct short procedural chime; params seeded by gift id so each differs."""
    rnd = random.Random('audio:'+gid)
    sr = 22050; dur = 0.8
    base = rnd.uniform(220, 740)
    harmonics = [(1.0, base), (rnd.uniform(0.3,0.6), base*rnd.choice([1.5,2.0,2.5])),
                 (rnd.uniform(0.1,0.3), base*rnd.choice([3.0,4.0]))]
    n = int(sr*dur); frames = bytearray()
    for i in range(n):
        t = i/sr
        env = math.exp(-3.0*t) * (1-math.exp(-80*t))  # pluck envelope
        s = sum(a*math.sin(2*math.pi*f*t) for a,f in harmonics)
        v = int(max(-1,min(1, s*env/ sum(a for a,_ in harmonics)))*127)+128
        frames.append(v & 0xff)
    with wave.open(path,'wb') as w:
        w.setnchannels(1); w.setsampwidth(1); w.setframerate(sr)
        w.writeframes(bytes(frames))

def checksum(path):
    h = hashlib.sha256()
    with open(path,'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return 'sha256:'+h.hexdigest()

def main():
    gifts = []; manifest = []; seen_ids = set()
    for cat_key,(cat_name,items) in CATEGORIES.items():
        for name,tier in items:
            gid = gift_id(cat_key, name)
            assert gid not in seen_ids, f'duplicate id {gid}'
            seen_ids.add(gid)
            price = TIER_PRICE[tier]
            # 3D geometry spec
            gpath = os.path.join(MODELS, f'{gid}.geometry.json')
            spec = geometry_spec(gid, tier, cat_key)
            with open(gpath,'w') as f: json.dump(spec, f, indent=2)
            model_rel = f'assets/3d-models/{gid}.geometry.json'
            # audio
            requires_sound = tier in SOUND_TIERS
            audio_rel = None; audio_status='unresolved'; audio_sum=None; audio_reason='Distinct original sound effect has not yet been authored for this gift; no generic substitute is assigned.'
            if requires_sound:
                apath = os.path.join(AUDIO, f'{gid}.wav')
                synth_wav(apath, gid)
                audio_rel = f'assets/gift-audio/{gid}.wav'
                audio_status='resolved'
                audio_sum=checksum(apath)
                audio_reason=None
            gift = {
                'id': gid,
                'name': name,
                'category': cat_key,
                'categoryLabel': cat_name,
                'tier': tier,
                'description': f'{name} — original ZUNO {cat_name} gift (tier {tier}).',
                'priceCoins': price,
                'unlockRule': 'none' if tier<=3 else ('level>=5' if tier<=5 else 'level>=15'),
                'fx': TIER_FX[tier],
                'deviceRequirements': {'webgl': tier>=5, 'minTierForFullscreen': 7},
                'fallback': 'static-sprite' if tier>=5 else 'css-animation',
                'modelPath': model_rel,
                'audioPath': audio_rel,
                'audioStatus': audio_status,
                'audioReason': audio_reason,
                'assetVersion': '1.0.0',
                'license': 'ZUNO-Original (procedurally generated, platform-owned)',
                'attribution': 'Generated by scripts/generate_gifts.py',
            }
            gifts.append(gift)
            manifest.append({
                'giftId': gid, 'name': name, 'category': cat_key, 'priceCoins': price,
                'modelPath': model_rel, 'animation': spec['animation'],
                'audioPath': audio_rel, 'audioStatus': audio_status, 'audioReason': audio_reason,
                'assetVersion':'1.0.0',
                'deviceRequirements': gift['deviceRequirements'],
                'license': gift['license'],
                'modelChecksum': checksum(gpath),
                'audioChecksum': audio_sum,
            })
    gifts.sort(key=lambda g: g['id'])
    manifest.sort(key=lambda m: m['giftId'])
    with open(os.path.join(DATA,'gifts.json'),'w') as f: json.dump(gifts, f, indent=2)
    with open(os.path.join(MANIFEST,'gift-manifest.json'),'w') as f:
        json.dump({'version':'1.0.0','count':len(gifts),'gifts':manifest}, f, indent=2)
    sound = sum(1 for g in gifts if g['audioStatus']=='resolved')
    print(f'generated {len(gifts)} gifts across {len(CATEGORIES)} categories; '
          f'{sound} with bespoke audio; ids unique={len(seen_ids)==len(gifts)}')

if __name__ == '__main__':
    main()
