(function () {
  "use strict";

  /*
   * Draw Probability Calculator
   *
   * This file intentionally uses plain browser JavaScript so the app can run
   * from GitHub Pages or any other static host with no build step. The math is
   * exact combinatorics, not simulation.
   *
   * High-level flow:
   * 1. Read form inputs from the DOM.
   * 2. Convert user-friendly fields into a compact probability model.
   * 3. Enumerate every possible draw outcome and weight each by its exact
   *    hypergeometric probability.
   * 4. Render summary metrics, charts, and detail tables back into the DOM.
   *
   * Terminology:
   * - Basic mode: a card is either a success or a non-success.
   * - Combo mode: cards can have one or more roles, such as A, B, ramp, tutor.
   * - Target line: a set of requirements that must all be met.
   * - Alternative line: a separate target line; satisfying any line succeeds.
   */

  var $ = function (id) {
    return document.getElementById(id);
  };

  // Public-facing links and CTA copy. Change these when the host site changes.
  var MARKETING = {
    siteName: "John Penick",
    siteUrl: "https://www.johnpenick.com",
    topLinkLabel: "johnpenick.com",
    footerHeadline: "More tools, notes, and projects from John Penick",
    footerCopy: "Find related tools, notes, projects, and resources at johnpenick.com.",
    footerCtaLabel: "johnpenick.com"
  };

  var NS = "http://www.w3.org/2000/svg";
  var logFacts = [0];
  var comboTimer = 0;

  /*
   * Probability helpers
   *
   * Combinations can get large quickly: C(100, 50) is far beyond what should be
   * multiplied directly in JavaScript. Storing log-factorials lets the app
   * compute ratios of combinations without intermediate overflow. The final
   * probabilities are exponentiated back into normal decimal values.
   */
  function ensureLogFacts(n) {
    for (var i = logFacts.length; i <= n; i += 1) {
      logFacts[i] = logFacts[i - 1] + Math.log(i);
    }
  }

  function logChoose(n, k) {
    if (k < 0 || k > n || n < 0) return -Infinity;
    ensureLogFacts(n);
    return logFacts[n] - logFacts[k] - logFacts[n - k];
  }

  // Hypergeometric probability: drawing exactly `hits` successes when drawing
  // `draws` cards from a deck with `successes` marked cards.
  function hypergeom(total, successes, draws, hits) {
    // Impossible requests return 0 instead of throwing. This keeps all later
    // enumeration code simple: every branch can ask for a probability and then
    // ignore zero-probability outcomes.
    if (total < 0 || successes < 0 || draws < 0 || hits < 0) return 0;
    if (successes > total || draws > total || hits > successes || hits > draws) return 0;
    var misses = total - successes;
    if (draws - hits > misses) return 0;
    var logP = logChoose(successes, hits) + logChoose(misses, draws - hits) - logChoose(total, draws);
    return Math.exp(logP);
  }

  function intValue(id) {
    var value = Number($(id).value);
    if (!Number.isFinite(value)) return 0;
    return Math.floor(value);
  }

  function formatPct(value) {
    if (!Number.isFinite(value)) return "--";
    var pct = value * 100;
    // Tiny edge probabilities are easier to read with threshold labels than as
    // a row of zeros caused by rounding.
    if (pct > 0 && pct < 0.01) return "<0.01%";
    if (pct > 99.99 && pct < 100) return ">99.99%";
    return pct.toFixed(pct < 10 ? 2 : 1) + "%";
  }

  function formatNumber(value, digits) {
    if (!Number.isFinite(value)) return "--";
    return value.toFixed(digits == null ? 2 : digits);
  }

  function showStatus(message, isError) {
    var status = $("globalStatus");
    status.textContent = message || "";
    status.style.color = isError ? "#9d3c1b" : "";
  }

  function applyMarketingConfig() {
    var linkIds = ["brandTopLink", "brandFooterCta"];
    linkIds.forEach(function (id) {
      var link = $(id);
      if (!link) return;
      link.href = MARKETING.siteUrl;
      link.rel = "noopener";
    });
    $("brandTopLink").textContent = MARKETING.topLinkLabel;
    $("brandFooterCta").textContent = MARKETING.footerCtaLabel;
    $("marketingHeadline").textContent = MARKETING.footerHeadline;
    $("marketingCopy").textContent = MARKETING.footerCopy;
  }

  // Read and validate the basic calculator's form inputs. Overrides let sweep
  // charts reuse the same calculator with one variable changed.
  function readBasicInput(overrides) {
    var input = {
      deckSize: intValue("deckSize"),
      successes: intValue("successes"),
      initialHand: intValue("initialHand"),
      replacedCards: intValue("replacedCards"),
      additionalDraws: intValue("additionalDraws"),
      targetSuccesses: intValue("targetSuccesses"),
      replacePolicy: $("replacePolicy").value,
      shuffleTiming: $("shuffleTiming").value
    };
    if (overrides) {
      // Sweep charts call the same calculator many times while overriding only
      // one field, such as additionalDraws = 0, 1, 2, ...
      Object.keys(overrides).forEach(function (key) {
        input[key] = overrides[key];
      });
    }
    return input;
  }

  function validateBasic(input) {
    var errors = [];
    // These checks protect the probability functions from impossible deck
    // states, such as drawing more cards than exist after the opening hand.
    if (input.deckSize < 1) errors.push("Deck size must be at least 1.");
    if (input.successes < 0 || input.successes > input.deckSize) errors.push("Successes must be between 0 and deck size.");
    if (input.initialHand < 0 || input.initialHand > input.deckSize) errors.push("Initial hand must fit inside the deck.");
    if (input.replacedCards < 0 || input.replacedCards > input.initialHand) errors.push("Cards replaced must be between 0 and initial hand.");
    if (input.additionalDraws < 0) errors.push("Additional draws cannot be negative.");
    if (input.targetSuccesses < 0) errors.push("Target successes cannot be negative.");
    if (input.additionalDraws > input.deckSize - input.initialHand) errors.push("Additional draws exceed the deck remaining after the initial hand.");
    if (input.shuffleTiming === "post" && input.replacedCards > input.deckSize - input.initialHand) {
      errors.push("Post-shuffle replacement needs enough cards left to draw replacements.");
    }
    return errors;
  }

  // In basic mode, replacement can either protect successes by replacing
  // non-successes first, or choose a random subset of the opening hand. This
  // returns all possible successful-card drop counts and their probabilities.
  function basicDropOptions(initialSuccesses, handSize, replaced, policy) {
    if (replaced === 0) return [{ dropSuccesses: 0, probability: 1 }];
    if (policy === "random") {
      var options = [];
      // If the hand contains too few non-successes to fill the replacement
      // count, at least some successes must be replaced.
      var minDrop = Math.max(0, replaced - (handSize - initialSuccesses));
      // At most, the user can replace every success currently in hand.
      var maxDrop = Math.min(initialSuccesses, replaced);
      for (var drop = minDrop; drop <= maxDrop; drop += 1) {
        options.push({
          dropSuccesses: drop,
          probability: hypergeom(handSize, initialSuccesses, replaced, drop)
        });
      }
      return options;
    }
    return [{
      // "Non-successes first" is deterministic until the number of replaced
      // cards exceeds the number of non-successes in hand.
      dropSuccesses: Math.max(0, replaced - (handSize - initialSuccesses)),
      probability: 1
    }];
  }

  // Exact basic-mode calculation:
  // 1. Enumerate possible successes in the initial hand.
  // 2. Enumerate which cards are replaced.
  // 3. Draw replacements according to when replaced cards are shuffled in.
  // 4. Draw any later cards and accumulate the final success distribution.
  function calculateBasic(input) {
    var errors = validateBasic(input);
    if (errors.length) {
      return { errors: errors, distribution: [] };
    }

    var N = input.deckSize;
    var K = input.successes;
    var H = input.initialHand;
    var R = input.replacedCards;
    var D = input.additionalDraws;
    var T = input.targetSuccesses;
    // Map key: final number of successes seen.
    // Map value: probability of ending with exactly that many successes.
    var distribution = new Map();

    // Bounds skip impossible initial-hand hit counts. Example: with 12
    // successes in a 60 card deck and a 7 card hand, only 0..7 are possible.
    var minInitial = Math.max(0, H - (N - K));
    var maxInitial = Math.min(K, H);

    for (var initialHits = minInitial; initialHits <= maxInitial; initialHits += 1) {
      var pInitial = hypergeom(N, K, H, initialHits);
      var dropOptions = basicDropOptions(initialHits, H, R, input.replacePolicy);

      dropOptions.forEach(function (dropOption) {
        if (dropOption.probability <= 0) return;
        var dropSucc = dropOption.dropSuccesses;
        var keptSucc = initialHits - dropSucc;

        // Pre-shuffle replacement puts replaced cards back before replacement
        // cards are drawn. Post-shuffle replacement waits until after that draw.
        var repTotal = input.shuffleTiming === "pre" ? N - H + R : N - H;
        var repSuccesses = input.shuffleTiming === "pre" ? K - initialHits + dropSucc : K - initialHits;
        // Replacement draw bounds: draw exactly R replacement cards from the
        // current replacement pool and enumerate how many of those are successes.
        var minRep = Math.max(0, R - (repTotal - repSuccesses));
        var maxRep = Math.min(repSuccesses, R);

        for (var repSucc = minRep; repSucc <= maxRep; repSucc += 1) {
          var pRep = hypergeom(repTotal, repSuccesses, R, repSucc);
          if (pRep <= 0) continue;

          var addTotal;
          var addSuccesses;
          if (input.shuffleTiming === "pre") {
            addTotal = repTotal - R;
            addSuccesses = repSuccesses - repSucc;
          } else {
            // In post-shuffle mode, replaced cards re-enter the deck before
            // later draws, so dropped successes are added back here.
            addTotal = N - H;
            addSuccesses = K - initialHits - repSucc + dropSucc;
          }

          var minAdd = Math.max(0, D - (addTotal - addSuccesses));
          var maxAdd = Math.min(addSuccesses, D);
          for (var addSucc = minAdd; addSucc <= maxAdd; addSucc += 1) {
            var pAdd = hypergeom(addTotal, addSuccesses, D, addSucc);
            if (pAdd <= 0) continue;
            var finalHits = keptSucc + repSucc + addSucc;
            // Independent staged probabilities multiply: opening hand outcome,
            // replacement choice, replacement draw, and later draw.
            var probability = pInitial * dropOption.probability * pRep * pAdd;
            distribution.set(finalHits, (distribution.get(finalHits) || 0) + probability);
          }
        }
      });
    }

    var rows = Array.from(distribution.keys()).sort(function (a, b) { return a - b; }).map(function (hits) {
      return { hits: hits, probability: distribution.get(hits) };
    });
    var pAtLeast = rows.reduce(function (sum, row) {
      return sum + (row.hits >= T ? row.probability : 0);
    }, 0);
    var expected = rows.reduce(function (sum, row) {
      return sum + row.hits * row.probability;
    }, 0);
    var zero = distribution.get(0) || 0;

    return {
      errors: [],
      distribution: rows,
      pAtLeast: pAtLeast,
      expected: expected,
      zero: zero
    };
  }

  function renderError(container, errors) {
    container.innerHTML = "";
    var box = document.createElement("div");
    box.className = "error-box";
    box.textContent = errors.join(" ");
    container.appendChild(box);
  }

  function renderBasic() {
    var input = readBasicInput();
    var result = calculateBasic(input);

    if (result.errors.length) {
      // Keep stale successful numbers from remaining on screen after an invalid
      // edit, such as setting cards replaced higher than initial hand size.
      $("basicProbability").textContent = "--";
      $("basicExpected").textContent = "--";
      $("basicZero").textContent = "--";
      renderError($("basicDistribution"), result.errors);
      $("basicTable").innerHTML = "";
      clearChart($("basicSweepChart"), "Invalid input");
      showStatus(result.errors[0], true);
      return;
    }

    $("basicProbability").textContent = formatPct(result.pAtLeast);
    $("basicExpected").textContent = formatNumber(result.expected, 2);
    $("basicZero").textContent = formatPct(result.zero);
    renderBasicDistribution(result.distribution);
    renderBasicTable(result.distribution);
    renderBasicSweep(input);
    showStatus("", false);
  }

  function renderBasicDistribution(rows) {
    var container = $("basicDistribution");
    container.innerHTML = "";
    if (!rows.length) {
      container.innerHTML = '<div class="empty-state">No distribution</div>';
      return;
    }
    // Bars are normalized to the largest bucket so small probability buckets
    // remain visible even when the whole distribution is narrow.
    var max = Math.max.apply(null, rows.map(function (row) { return row.probability; }));
    rows.forEach(function (row) {
      var item = document.createElement("div");
      item.className = "bar-row";
      var label = document.createElement("span");
      label.textContent = String(row.hits);
      var track = document.createElement("div");
      track.className = "bar-track";
      var fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = (max > 0 ? row.probability / max * 100 : 0).toFixed(3) + "%";
      var value = document.createElement("span");
      value.textContent = formatPct(row.probability);
      track.appendChild(fill);
      item.appendChild(label);
      item.appendChild(track);
      item.appendChild(value);
      container.appendChild(item);
    });
  }

  function renderBasicTable(rows) {
    var body = $("basicTable");
    body.innerHTML = "";
    var max = Math.max.apply(null, rows.map(function (row) { return row.probability; }).concat([0]));
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var hits = document.createElement("td");
      hits.textContent = String(row.hits);
      var prob = document.createElement("td");
      prob.textContent = formatPct(row.probability);
      var viz = document.createElement("td");
      viz.className = "prob-cell";
      var track = document.createElement("div");
      track.className = "mini-track";
      var fill = document.createElement("div");
      fill.className = "mini-fill";
      fill.style.width = (max > 0 ? row.probability / max * 100 : 0).toFixed(3) + "%";
      track.appendChild(fill);
      viz.appendChild(track);
      tr.appendChild(hits);
      tr.appendChild(prob);
      tr.appendChild(viz);
      body.appendChild(tr);
    });
  }

  // Sweep charts are small what-if tables. The active form values stay fixed
  // except for one selected variable.
  function buildSweepValues(input, variable) {
    var values = [];
    var max;
    if (variable === "additionalDraws") {
      max = Math.min(input.deckSize - input.initialHand, Math.max(20, input.additionalDraws));
      for (var d = 0; d <= max; d += 1) values.push(d);
    } else if (variable === "initialHand") {
      max = Math.min(input.deckSize, Math.max(20, input.initialHand));
      for (var h = 0; h <= max; h += 1) values.push(h);
    } else if (variable === "replacedCards") {
      for (var r = 0; r <= input.initialHand; r += 1) values.push(r);
    } else {
      for (var k = 0; k <= input.deckSize; k += 1) values.push(k);
    }
    if (values.length > 90) {
      // Avoid drawing hundreds of SVG points for large decks. The endpoints are
      // preserved so the chart still shows the full input range.
      var sampled = [];
      for (var i = 0; i < values.length; i += Math.ceil(values.length / 90)) sampled.push(values[i]);
      if (sampled[sampled.length - 1] !== values[values.length - 1]) sampled.push(values[values.length - 1]);
      values = sampled;
    }
    return values;
  }

  function renderBasicSweep(input) {
    var variable = $("basicSweep").value;
    var points = buildSweepValues(input, variable).map(function (value) {
      var next = {};
      next[variable] = value;
      if (variable === "initialHand" && input.replacedCards > value) {
        // A sweep can temporarily make the opening hand smaller than the
        // current replacement count. Clamp replacement count for that point so
        // the sweep still gives useful nearby values.
        next.replacedCards = value;
      }
      var result = calculateBasic(readBasicInput(next));
      return {
        x: value,
        y: result.errors.length ? NaN : result.pAtLeast
      };
    }).filter(function (point) {
      return Number.isFinite(point.y);
    });
    renderLineChart($("basicSweepChart"), points, { yMax: 1, yFormat: formatPct });
  }

  // Shared SVG chart helpers. Keeping chart rendering local avoids a dependency
  // and keeps the GitHub Pages deployment to plain static files.
  function clearChart(svg, label) {
    svg.innerHTML = "";
    var text = document.createElementNS(NS, "text");
    text.setAttribute("x", "320");
    text.setAttribute("y", "150");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "#69716c");
    text.textContent = label;
    svg.appendChild(text);
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (key) {
      el.setAttribute(key, attrs[key]);
    });
    return el;
  }

  function renderLineChart(svg, points, options) {
    svg.innerHTML = "";
    if (!points.length) {
      clearChart(svg, "No data");
      return;
    }
    var width = 640;
    var height = 300;
    var padL = 48;
    var padR = 22;
    var padT = 20;
    var padB = 42;
    var xMin = points[0].x;
    var xMax = points[points.length - 1].x;
    var yMax = options && options.yMax ? options.yMax : Math.max.apply(null, points.map(function (p) { return p.y; }));
    yMax = yMax <= 0 ? 1 : yMax;

    // These scales map logical chart coordinates into the fixed SVG viewBox.
    // Keeping chart dimensions fixed makes the layout stable across resizes.
    function xScale(x) {
      if (xMax === xMin) return padL;
      return padL + (x - xMin) / (xMax - xMin) * (width - padL - padR);
    }

    function yScale(y) {
      return height - padB - y / yMax * (height - padT - padB);
    }

    for (var gy = 0; gy <= 4; gy += 1) {
      // Five horizontal grid lines: 0%, 25%, 50%, 75%, 100% for probability
      // charts, or comparable spacing if a future chart uses another range.
      var yValue = yMax * gy / 4;
      var y = yScale(yValue);
      svg.appendChild(svgEl("line", {
        x1: padL,
        x2: width - padR,
        y1: y,
        y2: y,
        stroke: "#e4dccf",
        "stroke-width": "1"
      }));
      var label = svgEl("text", {
        x: padL - 10,
        y: y + 4,
        "text-anchor": "end",
        fill: "#69716c",
        "font-size": "12"
      });
      label.textContent = options && options.yFormat ? options.yFormat(yValue) : formatNumber(yValue, 2);
      svg.appendChild(label);
    }

    svg.appendChild(svgEl("line", {
      x1: padL,
      x2: width - padR,
      y1: height - padB,
      y2: height - padB,
      stroke: "#bfb6a8",
      "stroke-width": "1.5"
    }));
    svg.appendChild(svgEl("line", {
      x1: padL,
      x2: padL,
      y1: padT,
      y2: height - padB,
      stroke: "#bfb6a8",
      "stroke-width": "1.5"
    }));

    var path = points.map(function (point, index) {
      return (index === 0 ? "M " : " L ") + xScale(point.x).toFixed(2) + " " + yScale(point.y).toFixed(2);
    }).join("");
    svg.appendChild(svgEl("path", {
      d: path,
      fill: "none",
      stroke: "#187a72",
      "stroke-width": "4",
      "stroke-linecap": "round",
      "stroke-linejoin": "round"
    }));

    points.forEach(function (point, index) {
      // Mark a small subset of points to give the line texture without making
      // dense sweeps look noisy.
      if (index % Math.max(1, Math.ceil(points.length / 12)) !== 0 && index !== points.length - 1) return;
      svg.appendChild(svgEl("circle", {
        cx: xScale(point.x),
        cy: yScale(point.y),
        r: "4",
        fill: "#b7572d",
        stroke: "#fffaf1",
        "stroke-width": "2"
      }));
    });

    [points[0], points[points.length - 1]].forEach(function (point, index) {
      var label = svgEl("text", {
        x: xScale(point.x),
        y: height - 14,
        "text-anchor": index === 0 ? "start" : "end",
        fill: "#69716c",
        "font-size": "12"
      });
      label.textContent = String(point.x);
      svg.appendChild(label);
    });
  }

  // Internally this code still uses "tag" as the data name. The UI calls these
  // "roles" because that is clearer for people building combo requirements.
  function parseTags(value) {
    return String(value || "").split(/[\s,]+/).map(function (tag) {
      return tag.trim();
    }).filter(Boolean);
  }

  function readTargetRows() {
    return Array.from($("targetRows").querySelectorAll("tr")).map(function (row) {
      // A target row is a single requirement. Example:
      // line=1, min=2, roles=["A","B"] means "line 1 needs at least two cards
      // that have role A or role B."
      return {
        line: Math.max(1, Math.floor(Number(row.querySelector(".line-input").value) || 1)),
        min: Math.max(1, Math.floor(Number(row.querySelector(".need-input").value) || 1)),
        roles: parseTags(row.querySelector(".roles-input").value)
      };
    }).filter(function (row) {
      return row.roles.length;
    });
  }

  // The friendly target builder is converted into the compact expression
  // language used by the exact combo evaluator. Rows with the same line number
  // are AND requirements; different line numbers are OR alternatives.
  function buildExpressionFromTargetRows() {
    var byLine = new Map();
    readTargetRows().forEach(function (row) {
      if (!byLine.has(row.line)) byLine.set(row.line, []);
      // Single-role rows can use the simpler A>=1 syntax. Multi-role rows use
      // any(A,B)>=N to mean cards from any listed role count toward the same
      // requirement.
      var segment = row.roles.length === 1
        ? row.roles[0] + ">=" + row.min
        : "any(" + row.roles.join(",") + ")>=" + row.min;
      byLine.get(row.line).push(segment);
    });

    return Array.from(byLine.keys()).sort(function (a, b) { return a - b; }).map(function (line) {
      return byLine.get(line).join(" + ");
    }).join(" | ");
  }

  // Split only at top-level separators so expressions such as any(A,B,C)>=2
  // are not broken by separators inside parentheses.
  function splitTopLevel(value, separator) {
    var parts = [];
    var current = "";
    var depth = 0;
    for (var i = 0; i < value.length; i += 1) {
      var ch = value[i];
      if (ch === "(") depth += 1;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === separator && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  /*
   * Internal combo expression syntax:
   *   A>=1 + B>=1          means A and B are both required.
   *   any(A,B,C)>=2        means any two cards from that role group are enough.
   *   A>=1 + B>=1 | C>=3   means either line can satisfy the combo.
   */
  function parseExpression(expression) {
    var errors = [];
    var relevantTags = new Set();
    var alternatives = splitTopLevel(String(expression || "").trim(), "|").map(function (line) {
      var requirements = splitTopLevel(line, "+").map(function (part) {
        // Supported internal grammar:
        //   any(A,B)>=2
        //   A>=1
        //   A       (shorthand for A>=1)
        var anyMatch = part.match(/^any\s*\(([^)]*)\)\s*>=\s*(\d+)$/i);
        var tagMatch = part.match(/^([A-Za-z0-9_-]+)\s*>=\s*(\d+)$/);
        var bareMatch = part.match(/^([A-Za-z0-9_-]+)$/);
        var tags;
        var min;
        if (anyMatch) {
          tags = parseTags(anyMatch[1]);
          min = Number(anyMatch[2]);
        } else if (tagMatch) {
          tags = [tagMatch[1]];
          min = Number(tagMatch[2]);
        } else if (bareMatch) {
          tags = [bareMatch[1]];
          min = 1;
        } else {
          errors.push("Could not parse target segment: " + part);
          return null;
        }
        if (!tags.length || min < 0) {
          errors.push("Invalid target segment: " + part);
          return null;
        }
        tags.forEach(function (tag) { relevantTags.add(tag); });
        // A requirement stores the role names it can count and the minimum
        // number of drawn cards needed for that requirement.
        return {
          raw: part,
          tags: tags,
          min: min
        };
      }).filter(Boolean);
      return { raw: line, requirements: requirements };
    }).filter(function (line) {
      return line.requirements.length;
    });

    if (!alternatives.length) errors.push("Enter at least one target expression.");
    return {
      errors: errors,
      alternatives: alternatives,
      relevantTags: relevantTags
    };
  }

  function readDeckRows() {
    return Array.from($("deckRows").querySelectorAll("tr")).map(function (row) {
      // A physical deck row can have multiple roles. For example, a tutor could
      // be tagged "wild" and a card that satisfies two combo pieces could be
      // tagged "A B".
      return {
        qty: Math.max(0, Math.floor(Number(row.querySelector(".qty-input").value) || 0)),
        name: row.querySelector(".name-input").value.trim(),
        tags: parseTags(row.querySelector(".tags-input").value)
      };
    }).filter(function (row) {
      return row.qty > 0;
    });
  }

  // Collapse individual deck rows into active role groups. Exact enumeration
  // only needs to distinguish roles mentioned by the expression and wildcard
  // tag; every other card can share a filler group.
  function buildCategories(rows, parsed, wildcardTag) {
    var relevant = new Set(parsed.relevantTags);
    if (wildcardTag) relevant.add(wildcardTag);
    var byKey = new Map();
    rows.forEach(function (row) {
      // Ignore roles that do not affect the current target. This turns the deck
      // into the smallest exact state space needed for the calculation.
      var usefulTags = row.tags.filter(function (tag) {
        return relevant.has(tag);
      }).sort();
      var key = usefulTags.join(",");
      if (!byKey.has(key)) {
        // Rows with the same relevant-role set are mathematically
        // interchangeable. Example: two different A-only cards collapse into
        // one category with a combined quantity.
        byKey.set(key, { key: key, qty: 0, tags: usefulTags });
      }
      byKey.get(key).qty += row.qty;
    });
    return Array.from(byKey.values()).sort(function (a, b) {
      if (a.key === "") return 1;
      if (b.key === "") return -1;
      return a.key.localeCompare(b.key);
    });
  }

  function vectorAdd(a, b) {
    // Vector helpers operate category-by-category. If categories are
    // [A-only, B-only, wild, filler], then [1,0,1,5] means one A-only card,
    // zero B-only cards, one wildcard, and five filler cards.
    return a.map(function (value, index) { return value + b[index]; });
  }

  function vectorSub(a, b) {
    return a.map(function (value, index) { return value - b[index]; });
  }

  function zeroVector(length) {
    return Array.from({ length: length }, function () { return 0; });
  }

  function sum(values) {
    return values.reduce(function (total, value) { return total + value; }, 0);
  }

  // Enumerate every possible draw vector across active role groups. The callback
  // receives both the vector and its exact multivariate-hypergeometric
  // probability.
  function enumerateDraws(counts, draw, callback) {
    var total = sum(counts);
    if (draw < 0 || draw > total) return;
    if (draw === 0) {
      callback(zeroVector(counts.length), 1);
      return;
    }

    var suffix = zeroVector(counts.length + 1);
    for (var s = counts.length - 1; s >= 0; s -= 1) {
      // suffix[i] tells the recursion how many cards remain in categories i..end.
      // That lets each branch skip impossible pick counts.
      suffix[s] = suffix[s + 1] + counts[s];
    }

    var denom = logChoose(total, draw);
    var vector = zeroVector(counts.length);

    function walk(index, remaining, logNumerator) {
      if (index === counts.length - 1) {
        if (remaining >= 0 && remaining <= counts[index]) {
          vector[index] = remaining;
          // Multivariate hypergeometric:
          // product(C(categorySize, pickedFromCategory)) / C(total, draw)
          callback(vector.slice(), Math.exp(logNumerator + logChoose(counts[index], remaining) - denom));
        }
        return;
      }

      // Pick enough from this category to make the remaining categories capable
      // of completing the draw, but never more than this category contains.
      var minPick = Math.max(0, remaining - suffix[index + 1]);
      var maxPick = Math.min(counts[index], remaining);
      for (var picked = minPick; picked <= maxPick; picked += 1) {
        vector[index] = picked;
        walk(index + 1, remaining - picked, logNumerator + logChoose(counts[index], picked));
      }
      vector[index] = 0;
    }

    walk(0, draw, 0);
  }

  function categoryHasAny(category, tags) {
    return category.tags.some(function (tag) {
      return tags.has(tag);
    });
  }

  // A wildcard/tutor card covers one missing requirement in a satisfied
  // alternative. Example: with A>=1 + B>=1, one A plus one wildcard succeeds.
  function evaluateCombo(vector, categories, parsed, wildcardTag) {
    var wildcardCount = 0;
    if (wildcardTag) {
      categories.forEach(function (category, index) {
        if (category.tags.indexOf(wildcardTag) >= 0) {
          wildcardCount += vector[index];
        }
      });
    }

    return parsed.alternatives.some(function (line) {
      // For each alternative line, calculate how many requirement slots remain
      // uncovered by drawn non-wildcard cards. Wildcards can cover the deficit.
      var deficit = 0;
      line.requirements.forEach(function (requirement) {
        var reqTags = new Set(requirement.tags);
        var actual = 0;
        categories.forEach(function (category, index) {
          // Do not double-count wildcard cards as both normal role cards and
          // wildcards unless the requirement explicitly asks for the wildcard
          // role itself.
          var isWildcard = wildcardTag && category.tags.indexOf(wildcardTag) >= 0 && !reqTags.has(wildcardTag);
          if (!isWildcard && categoryHasAny(category, reqTags)) {
            actual += vector[index];
          }
        });
        deficit += Math.max(0, requirement.min - actual);
      });
      return deficit <= wildcardCount;
    });
  }

  function usefulCategory(category, parsed, wildcardTag) {
    var relevant = new Set(parsed.relevantTags);
    if (wildcardTag) relevant.add(wildcardTag);
    // A category is useful if it has any role that can help satisfy the current
    // target or serve as a wildcard.
    return categoryHasAny(category, relevant);
  }

  // Strategic combo replacement discards non-combo cards first. If more cards
  // must be replaced, the remaining combo-relevant cards are replaced at random.
  function comboDropOptions(initial, categories, replaced, policy, parsed, wildcardTag) {
    if (replaced === 0) return [{ vector: zeroVector(initial.length), probability: 1 }];

    if (policy === "random") {
      var randomOptions = [];
      enumerateDraws(initial, replaced, function (drop, probability) {
        randomOptions.push({ vector: drop, probability: probability });
      });
      return randomOptions;
    }

    var base = zeroVector(initial.length);
    var remaining = replaced;
    categories.forEach(function (category, index) {
      if (remaining <= 0) return;
      if (!usefulCategory(category, parsed, wildcardTag)) {
        // Deterministically spend replacement slots on categories that cannot
        // help the combo first.
        var picked = Math.min(initial[index], remaining);
        base[index] = picked;
        remaining -= picked;
      }
    });

    if (remaining <= 0) return [{ vector: base, probability: 1 }];

    var usefulCounts = initial.map(function (count, index) {
      // If all non-useful cards were already replaced and the user is replacing
      // more cards, the remaining replacement choices are random among useful
      // cards still in hand.
      return usefulCategory(categories[index], parsed, wildcardTag) ? count - base[index] : 0;
    });
    var options = [];
    enumerateDraws(usefulCounts, remaining, function (extra, probability) {
      options.push({
        vector: vectorAdd(base, extra),
        probability: probability
      });
    });
    return options;
  }

  function readComboInput() {
    // The visible target table is the source of truth. The expression field is
    // regenerated on every read and exists only so humans/AI can audit the
    // internal target representation.
    var expression = buildExpressionFromTargetRows();
    $("comboExpression").value = expression;
    var wildcardTag = $("wildcardTag").value.trim();
    var parsed = parseExpression(expression);
    var rows = readDeckRows();
    var categories = buildCategories(rows, parsed, wildcardTag);
    return {
      rows: rows,
      parsed: parsed,
      categories: categories,
      wildcardTag: wildcardTag,
      initialHand: intValue("comboInitialHand"),
      replacedCards: intValue("comboReplacedCards"),
      additionalDraws: intValue("comboAdditionalDraws"),
      replacePolicy: $("comboReplacePolicy").value,
      shuffleTiming: $("comboShuffleTiming").value
    };
  }

  function validateCombo(input) {
    var errors = input.parsed.errors.slice();
    var deckSize = input.rows.reduce(function (total, row) { return total + row.qty; }, 0);
    if (deckSize < 1) errors.push("Deck must contain at least one card.");
    if (input.initialHand < 0 || input.initialHand > deckSize) errors.push("Initial hand must fit inside the deck.");
    if (input.replacedCards < 0 || input.replacedCards > input.initialHand) errors.push("Cards replaced must be between 0 and initial hand.");
    if (input.additionalDraws < 0) errors.push("Additional draws cannot be negative.");
    if (input.additionalDraws > deckSize - input.initialHand) errors.push("Additional draws exceed the deck remaining after the initial hand.");
    if (input.shuffleTiming === "post" && input.replacedCards > deckSize - input.initialHand) {
      errors.push("Post-shuffle replacement needs enough cards left to draw replacements.");
    }
    if (input.categories.length > 9) {
      // Exact enumeration grows quickly with each distinct role group. This cap
      // keeps the page responsive for normal browser use.
      errors.push("Exact combo mode is capped at 9 active role groups.");
    }
    return errors;
  }

  // Exact combo-mode calculation mirrors basic mode, but each state is a vector
  // of active role groups instead of a single success count.
  function calculateComboProbability(input) {
    var errors = validateCombo(input);
    if (errors.length) return { errors: errors, probability: NaN };

    var counts = input.categories.map(function (category) { return category.qty; });
    var N = sum(counts);
    var H = input.initialHand;
    var R = input.replacedCards;
    var D = input.additionalDraws;
    var probability = 0;

    // Stage 1: enumerate the opening hand as a vector over active categories.
    enumerateDraws(counts, H, function (initial, pInitial) {
      if (pInitial <= 0) return;
      // Stage 2: enumerate which cards are replaced. Strategic replacement can
      // be partly deterministic, while random replacement has multiple branches.
      var dropOptions = comboDropOptions(initial, input.categories, R, input.replacePolicy, input.parsed, input.wildcardTag);
      dropOptions.forEach(function (dropOption) {
        if (dropOption.probability <= 0) return;
        var kept = vectorSub(initial, dropOption.vector);
        var afterInitialDeck = vectorSub(counts, initial);
        // Stage 3: build the replacement draw pool. Pre-shuffle adds dropped
        // cards back immediately; post-shuffle does not.
        var repPool = input.shuffleTiming === "pre" ? vectorAdd(afterInitialDeck, dropOption.vector) : afterInitialDeck;

        enumerateDraws(repPool, R, function (replacement, pReplacement) {
          if (pReplacement <= 0) return;
          var seenBeforeAdd = vectorAdd(kept, replacement);
          // In post-shuffle mode, dropped cards are unavailable for the
          // replacement draw but return before later additional draws.
          var addPool = input.shuffleTiming === "pre"
            ? vectorSub(repPool, replacement)
            : vectorAdd(vectorSub(afterInitialDeck, replacement), dropOption.vector);

          // Stage 4: enumerate additional draws, evaluate the final seen vector
          // against the combo target, and accumulate successful probability mass.
          enumerateDraws(addPool, D, function (additional, pAdditional) {
            if (pAdditional <= 0) return;
            var finalSeen = vectorAdd(seenBeforeAdd, additional);
            if (evaluateCombo(finalSeen, input.categories, input.parsed, input.wildcardTag)) {
              probability += pInitial * dropOption.probability * pReplacement * pAdditional;
            }
          });
        });
      });
    });

    return { errors: [], probability: probability };
  }

  // CDF used for the "how many cards until this combo appears" chart. This
  // ignores mulligans and asks a simpler raw-draw question.
  function calculateComboCdf(input) {
    var errors = validateCombo(input);
    if (errors.length) return { errors: errors, points: [], average: NaN };

    var counts = input.categories.map(function (category) { return category.qty; });
    var N = sum(counts);
    var points = [];
    var previous = 0;
    var average = 0;

    for (var draw = 0; draw <= N; draw += 1) {
      var cdf = 0;
      enumerateDraws(counts, draw, function (vector, probability) {
        if (evaluateCombo(vector, input.categories, input.parsed, input.wildcardTag)) {
          cdf += probability;
        }
      });
      points.push({ x: draw, y: cdf });
      // Convert the CDF into a first-hit distribution. The increase from the
      // previous CDF point is the probability that this exact draw count is the
      // first time the combo appears.
      average += draw * Math.max(0, cdf - previous);
      previous = cdf;
    }

    if (points[points.length - 1].y < 0.999999) {
      // If the combo is impossible even after the whole deck, "average draw hit"
      // is undefined rather than a large misleading number.
      average = NaN;
    }

    return { errors: [], points: points, average: average };
  }

  // Combo calculations can be heavier than basic calculations, so rendering is
  // debounced to keep typing in deck rows and expressions responsive.
  function renderCombo() {
    var comboVisible = $("comboPanel").classList.contains("active");
    if (comboVisible) showStatus("", false);
    window.clearTimeout(comboTimer);
    comboTimer = window.setTimeout(function () {
      // Since rendering is debounced, the user may switch tabs before this
      // callback runs. `stillVisible` prevents hidden combo renders from
      // overwriting the global status shown on the basic tab.
      var stillVisible = $("comboPanel").classList.contains("active");
      var input = readComboInput();
      var probabilityResult = calculateComboProbability(input);
      var cdfResult = calculateComboCdf(input);
      var deckSize = input.rows.reduce(function (total, row) { return total + row.qty; }, 0);

      refreshRoleOptions(input.rows, input.wildcardTag);
      $("comboDeckSize").textContent = String(deckSize);
      renderTagSummary(input);
      renderExpressionTable(input.parsed);

      var errors = probabilityResult.errors.length ? probabilityResult.errors : cdfResult.errors;
      if (errors.length) {
        $("comboProbability").textContent = "--";
        $("comboAverageDraw").textContent = "--";
        clearChart($("comboCdfChart"), "Invalid input");
        if (stillVisible) showStatus(errors[0], true);
        return;
      }

      $("comboProbability").textContent = formatPct(probabilityResult.probability);
      $("comboAverageDraw").textContent = Number.isFinite(cdfResult.average) ? formatNumber(cdfResult.average, 2) : "--";
      renderLineChart($("comboCdfChart"), downsamplePoints(cdfResult.points, 90), { yMax: 1, yFormat: formatPct });
      if (stillVisible) showStatus("", false);
    }, 60);
  }

  function downsamplePoints(points, limit) {
    if (points.length <= limit) return points;
    var step = Math.ceil(points.length / limit);
    var sampled = [];
    for (var i = 0; i < points.length; i += step) sampled.push(points[i]);
    if (sampled[sampled.length - 1].x !== points[points.length - 1].x) sampled.push(points[points.length - 1]);
    return sampled;
  }

  function refreshRoleOptions(rows, wildcardTag) {
    // Datalist suggestions are convenience only; users can still type a new
    // role that does not exist in the deck yet.
    var options = $("roleOptions");
    options.innerHTML = "";
    var roles = new Set();
    rows.forEach(function (row) {
      row.tags.forEach(function (tag) {
        roles.add(tag);
      });
    });
    if (wildcardTag) roles.add(wildcardTag);
    Array.from(roles).sort().forEach(function (role) {
      var option = document.createElement("option");
      option.value = role;
      options.appendChild(option);
    });
  }

  // Dynamic deck rows keep combo mode flexible without imposing a fixed card
  // schema. Roles are the contract between deck rows and target rows.
  function renderTagSummary(input) {
    var container = $("tagSummary");
    container.innerHTML = "";
    var totals = new Map();
    input.rows.forEach(function (row) {
      row.tags.forEach(function (tag) {
        if (input.parsed.relevantTags.has(tag) || tag === input.wildcardTag) {
          totals.set(tag, (totals.get(tag) || 0) + row.qty);
        }
      });
    });

    if (!totals.size) {
      container.innerHTML = '<div class="empty-state">No target roles</div>';
      return;
    }

    Array.from(totals.keys()).sort().forEach(function (tag) {
      var pill = document.createElement("div");
      pill.className = "tag-pill";
      var label = document.createElement("span");
      label.textContent = tag;
      var value = document.createElement("strong");
      value.textContent = String(totals.get(tag));
      pill.appendChild(label);
      pill.appendChild(value);
      container.appendChild(pill);
    });
  }

  function renderExpressionTable(parsed) {
    var body = $("expressionTable");
    body.innerHTML = "";
    if (parsed.errors.length) {
      // Parsing errors should be visible in the audit table because the
      // generated expression is hidden behind a collapsed details element.
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 2;
      td.textContent = parsed.errors.join(" ");
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    parsed.alternatives.forEach(function (line, index) {
      var tr = document.createElement("tr");
      var lineCell = document.createElement("td");
      lineCell.textContent = String(index + 1);
      var reqCell = document.createElement("td");
      reqCell.textContent = line.requirements.map(function (req) {
        return req.tags.join(",") + " >= " + req.min;
      }).join(" + ");
      tr.appendChild(lineCell);
      tr.appendChild(reqCell);
      body.appendChild(tr);
    });
  }

  function maxTargetLine() {
    // Used by "Add requirement" and "Add alternative" buttons to choose a
    // sensible default line number for the next target row.
    return readTargetRows().reduce(function (max, row) {
      return Math.max(max, row.line);
    }, 1);
  }

  function addTargetRow(line, min, roles) {
    var template = $("targetRowTemplate");
    var node = template.content.firstElementChild.cloneNode(true);
    // Rows are created from a template so event listeners can be attached to
    // each new input immediately.
    node.querySelector(".line-input").value = line == null ? maxTargetLine() : line;
    node.querySelector(".need-input").value = min == null ? 1 : min;
    node.querySelector(".roles-input").value = roles || "";
    node.querySelector(".remove-target-row").addEventListener("click", function () {
      node.remove();
      renderCombo();
    });
    node.querySelectorAll("input").forEach(function (input) {
      input.addEventListener("input", renderCombo);
    });
    $("targetRows").appendChild(node);
  }

  function addDeckRow(qty, name, tags) {
    var template = $("deckRowTemplate");
    var node = template.content.firstElementChild.cloneNode(true);
    // Deck rows are dynamic for the same reason target rows are: the app should
    // work for generic shuffled-deck problems without a fixed card schema.
    node.querySelector(".qty-input").value = qty == null ? 4 : qty;
    node.querySelector(".name-input").value = name || "Card";
    node.querySelector(".tags-input").value = tags || "";
    node.querySelector(".remove-row").addEventListener("click", function () {
      node.remove();
      renderCombo();
    });
    node.querySelectorAll("input").forEach(function (input) {
      input.addEventListener("input", renderCombo);
    });
    $("deckRows").appendChild(node);
  }

  function loadComboExample() {
    // A compact example deck: A piece, B piece, a wildcard/tutor, and filler.
    // The target requires A and B, so drawing A+wild or B+wild also succeeds.
    $("deckRows").innerHTML = "";
    $("targetRows").innerHTML = "";
    addDeckRow(4, "Piece A", "A");
    addDeckRow(4, "Piece B", "B");
    addDeckRow(4, "Tutor", "wild");
    addDeckRow(48, "Filler", "");
    addTargetRow(1, 1, "A");
    addTargetRow(1, 1, "B");
    $("comboExpression").value = buildExpressionFromTargetRows();
    $("wildcardTag").value = "wild";
    $("comboInitialHand").value = 7;
    $("comboReplacedCards").value = 0;
    $("comboAdditionalDraws").value = 0;
    $("comboReplacePolicy").value = "misses";
    $("comboShuffleTiming").value = "pre";
    renderCombo();
  }

  function resetBasic() {
    $("deckSize").value = 60;
    $("successes").value = 4;
    $("initialHand").value = 7;
    $("replacedCards").value = 0;
    $("additionalDraws").value = 0;
    $("targetSuccesses").value = 1;
    $("replacePolicy").value = "misses";
    $("shuffleTiming").value = "pre";
    $("basicSweep").value = "additionalDraws";
    renderBasic();
  }

  function setMode(mode, updateHash) {
    var basic = mode === "basic";
    $("basicTab").classList.toggle("active", basic);
    $("comboTab").classList.toggle("active", !basic);
    $("basicTab").setAttribute("aria-selected", basic ? "true" : "false");
    $("comboTab").setAttribute("aria-selected", basic ? "false" : "true");
    $("basicPanel").classList.toggle("active", basic);
    $("comboPanel").classList.toggle("active", !basic);
    if (updateHash) {
      // Hashes make it possible to link directly to the combo builder with
      // index.html#combo from documentation or a public site.
      window.location.hash = basic ? "basic" : "combo";
    }
    if (basic) renderBasic();
    else renderCombo();
  }

  function bindEvents() {
    $("basicTab").addEventListener("click", function () { setMode("basic", true); });
    $("comboTab").addEventListener("click", function () { setMode("combo", true); });
    $("basicReset").addEventListener("click", resetBasic);
    $("basicForm").addEventListener("input", renderBasic);
    $("basicForm").addEventListener("change", renderBasic);

    $("comboExample").addEventListener("click", loadComboExample);
    $("addCardRow").addEventListener("click", function () {
      addDeckRow(4, "Card", "");
      renderCombo();
    });
    $("addRequirementRow").addEventListener("click", function () {
      addTargetRow(maxTargetLine(), 1, "");
      renderCombo();
    });
    $("addAlternativeLine").addEventListener("click", function () {
      addTargetRow(maxTargetLine() + 1, 1, "");
      renderCombo();
    });
    $("comboForm").addEventListener("input", renderCombo);
    $("comboForm").addEventListener("change", renderCombo);
  }

  applyMarketingConfig();
  bindEvents();
  loadComboExample();
  setMode(window.location.hash === "#combo" ? "combo" : "basic", false);
}());
