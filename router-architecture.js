"use strict";

/* Static architecture diagram with a subtle, looping "flow" highlight.
   No API calls — it just walks the diagram left-to-right so the routing path reads
   as a sequence, reusing the same .active/.reached/.streaming treatment as app.js. */

const STEP_MS = 620;   // dwell on each step
const LOOP_GAP = 1400; // pause on the finished diagram before restarting

function nodesByStep() {
  // group elements by their data-step so a whole column lights at once
  const groups = [];
  document.querySelectorAll("#arch [data-step]").forEach((el) => {
    const i = Number(el.dataset.step);
    (groups[i] = groups[i] || []).push(el);
  });
  return groups.filter(Boolean);
}

function clearAll(groups) {
  groups.flat().forEach((el) => el.classList.remove("active", "reached", "streaming", "lit"));
}

function light(groups, i) {
  groups.forEach((group, gi) => {
    group.forEach((el) => {
      el.classList.remove("active", "streaming", "lit");
      const isCriteria = el.classList.contains("arch-criteria");
      const isOutput = el.classList.contains("output");
      if (gi < i) {
        // already passed — settle into the calm "reached" state
        el.classList.add(isCriteria ? "lit" : "reached");
      } else if (gi === i) {
        if (isCriteria) el.classList.add("lit");
        else el.classList.add(isOutput ? "streaming" : "active");
      } else {
        el.classList.remove("reached");
      }
    });
  });
}

function run(groups) {
  let i = 0;
  const tick = () => {
    if (i < groups.length) {
      light(groups, i);
      i += 1;
      setTimeout(tick, STEP_MS);
    } else {
      // hold the completed diagram, then reset and loop
      setTimeout(() => { clearAll(groups); i = 0; setTimeout(tick, STEP_MS); }, LOOP_GAP);
    }
  };
  tick();
}

function init() {
  const groups = nodesByStep();
  if (!groups.length) return;
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    // no motion — present the whole path in its settled state
    groups.flat().forEach((el) => {
      el.classList.add(el.classList.contains("arch-criteria") ? "lit" : "reached");
    });
    return;
  }
  run(groups);
}

document.addEventListener("DOMContentLoaded", init);
