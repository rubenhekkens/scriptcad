# Topology optimisation of a B1 pile table (pallet lift platform)

An experiment with ScriptCAD's *Remove unused material* (BESO, `web/fea/topo.js`) on a real
product: the platform that lifts a pallet with a pile of B1 sheets into the feeder of a
production printer, with nonstop (fast) pallet exchange.

## The product

* **B1 production presses** take sheets up to about 750 × 1060 mm. Examples are the Heidelberg
  Speedmaster XL 106 (offset) and the Primefire 106 (inkjet, based on the same feeder). The XL
  106 feeder is 1,320 mm high including the pile table, so paper piles are a little over a
  metre high.
* **Nonstop pallet exchange** keeps the press running. Rods or a rake slide into grooves in a
  special pallet and carry the remaining pile. The main pile table then lowers, the pallet is
  swapped, and the new pile rises under the rods until they can be pulled out (patents
  US5295681, US7748702, US12006172).
* **The pile table** is the platform carrying pallet and pile. It is lifted by chains at its
  four corners. It has to stay flat, because the feeder head senses the pile top.

**Assumed design load** (the pile weight isn't published): a B1 pile 1.3 m high of coated
paper (about 1,200 kg/m³) weighs about 1,240 kg. With the pallet that's **13 kN**. The pallet
is 1200 × 1000 mm.

## Experiment

**Question:** under the same supports and loads, how much better does topology optimisation
place the steel than a conventional welded frame, and does it still hold under a load it was
not optimised for?

* **Envelope:** steel, 1300 × 1100 × 120 mm, with four chain lugs (60 × 60 mm) under the
  corners, held fixed (`src/scriptcad/web/examples/pallet_lift.json`, also in the File menu).
* **Load cases** (forces on the top-surface nodes):
  * **LC1, design load:** full B1 pile, 13 kN over the 1200 × 1000 pallet footprint.
  * **LC2, robustness:** short B2 pile, 5.7 kN over 720 × 520 mm against the pallet's front
    edge (a smaller format, aligned to the front lay). Never seen by the optimiser.
* **Designs**, all on **one voxel grid** (200 × 169 × 23, 6.6 mm voxels, 1.9 M unknowns):
  * **solid:** the full envelope (upper bound on stiffness).
  * **frame:** a conventional ladder frame: hollow 80 × 120 mm tubes (3 longitudinal, 4
    cross, walls ≈ 6.6 mm) welded under a 13 mm deck plate.
  * **E1:** carved for LC1 down to the frame's exact mass.
  * **E2:** carved for LC1 to the lightest design no softer than the frame (deflection limit =
    the frame's LC1 deflection).
* **Measured:** largest deflection, pile-top sag (spread of vertical displacement across the
  loaded top, which is what the feeder sees) and compliance f·u.
* **Hardware:** the app's WebGPU solver and optimiser on an RTX 5070 in Chrome, 371 s in total.
  Harness: `pallet_experiment.js`. Numbers: `results/pallet_results.json`.

## Results

| Design | Mass | LC1 deflection | LC1 sag | LC2 deflection | LC2 sag |
|---|---:|---:|---:|---:|---:|
| solid envelope | 1,332 kg | 9.1 µm | 8.5 µm | 6.2 µm | 2.6 µm |
| welded tube frame | 275 kg | 52.8 µm | 50.3 µm | 45.2 µm | 29.9 µm |
| **E1** carved, same mass | 275 kg | **34.9 µm (−34%)** | **31.0 µm (−38%)** | 40.3 µm (−11%) | 27.2 µm (−9%) |
| **E2** carved, same stiffness | **241 kg (−12%)** | 43.1 µm (−18%) | 37.3 µm (−26%) | **56.2 µm (+24%)** | 41.1 µm (+37%) |

Percentages are against the frame. In compliance, E1 is 1.60× stiffer than the frame under LC1.

![Underside of the three designs](../../docs/pile-table-designs.jpg)

## What it shows

1. **At equal mass the carved platform is 1.5× stiffer, and the pile top sags 38% less.** The
   optimiser drops the outer tubes, which carry little (blue in the frame picture). Instead it
   grows a branching bracket from each chain lug into the deck, plus a rectangular ring under
   the middle of the pallet. The 13 mm deck plate spans between them. The frame's material
   sits along the edges; the carved design puts it on the path from the pile to the four lugs.
2. **The mass saving at equal stiffness is modest.** E2 reached 241 kg (−12%) and was still
   18% stiffer than the frame when the next 3% step went over the limit. The design is close
   to a **cliff**: the 13 mm deck plate that Carve must keep under the load is already 9.7% of
   the envelope, and once the last brackets thin out, stiffness collapses. A finer step near
   the end would find a slightly lighter design at exactly the frame's stiffness, maybe 15–20%
   lighter. That is a guess, not a measurement.
3. **Optimising for one load case overfits.** Under the front-edge B2 pile it never saw, the
   same-mass design E1 is still 11% better than the frame. The lighter E2 is 24% *worse*, and
   its pile top sags 37% more. The frame's uniform grid of tubes serves loads it was not
   designed for. A carved table needs both load cases in the optimisation (not yet supported)
   or a margin on the limit.
4. **For fast pallet exchange the weight saving barely matters.** The lift moves pile plus
   pallet plus table: about 1,330 kg + 275 kg. Saving 34 kg on the table is about 2% of the
   moving mass. What matters for nonstop feeding is the **flatness**: the pile top must stay
   level while the rods take over the residual pile, and that is where the carved design
   helps (38% less sag at the same mass).

## Limits

* **Idealisations:** linear elastic, static loads, no dynamic factor for pallet placement or
  lift acceleration.
* **Supports:** the lugs are held completely, as if clamped. Real chains only hold vertically
  and let the table tilt, so all designs come out stiffer than reality. That's also why the
  absolute deflections are tiny (tens of µm). The comparison between designs is what counts.
* **Not modelled:** the pallet itself, its nonstop grooves, and roller conveyors on the table
  for exchange. The pile load is spread evenly over the footprint.
* **No strength check.** The carved brackets at the lugs are the busiest steel (red) and would
  need a stress check and generous radii.
* **Manufacturing:** E1 and E2 are cast or additively made shapes, not a welded frame. A
  practical translation would be four corner gussets plus a central ring of flat bar under
  the deck. Re-analysing that translated design would be the real test.
* **Resolution:** 6.6 mm voxels, so the tube walls are one voxel thick (see `README.md` in this
  folder for how resolution affects Carve). The deck plate is 2 voxels (13 mm) in every design.
