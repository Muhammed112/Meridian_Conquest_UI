import { renderBrand, renderButton, renderIcon } from './components.js';
import { escapeHTML } from '../html.js';
import { initials } from '../data.js';
import { cloudEnabled } from '../cloud.js?v=match-commentary-20261026-1';

export function createNavigation(context) {
  function nav(active = '', compact = false) {
    const { cloud, profile } = context;

    return /* HTML */ `<header class="navbar ${compact ? 'game-nav' : ''}"
      >${renderBrand()}<nav class="nav-links" aria-label="Main navigation"
        ><a href="#campaigns" class="${active === 'campaigns' ? 'active' : ''}">My campaigns</a
        ><a href="#setup" class="${active === 'setup' ? 'active' : ''}">New campaign</a
        ><a href="#multiplayer" class="${active === 'multiplayer' ? 'active' : ''}">Multiplayer</a
        ><a href="#how-to-play">How to play</a></nav
      ><div class="nav-account"
        >${settingsControl()}${cloud?.user ? renderButton('Sign out', 'sign-out', 'btn-sm') : ''}${compact ? /* HTML */ `<a href="#campaigns" class="btn btn-ghost btn-sm">${renderIcon('back')} My games</a>` : ''}${profile ? /* HTML */ `<button class="account-link btn-ghost" data-action="account" title="Edit player nickname" aria-label="Edit player nickname"><span class="avatar">${escapeHTML(initials(profile.name))}</span><span class="account-name">${escapeHTML(profile.name)}</span></button>` : `${!compact ? '<span class="nav-demo">SINGLE-PLAYER STRATEGY</span>' : ''}<a href="#signin" class="link-button">Sign in</a>${!compact ? '<a href="#signup" class="btn btn-sm">Create account</a>' : ''}`}</div
      ></header
    >`;
  }

  function footer() {
    return /* HTML */ `<footer class="footer"
      ><span class="footer-name"
        >MERIDIAN CONQUEST <span class="gold">/</span> A WORLD OF POSSIBILITY.</span
      ><span>Interactive demo · Progress saved on this device</span
      ><a href="#how-to-play">Rules of engagement ↗</a></footer
    >`;
  }

  const settingsControl = () => {
    return renderButton(
      renderIcon('settings'),
      'settings',
      'btn-sm settings-trigger',
      'aria-haspopup="dialog" aria-controls="settings-dialog" aria-label="Settings" title="Animation and sound settings"',
    );
  };

  const motionControl = () => {
    const { motionDirector } = context;
    return renderButton(
      `${renderIcon(motionDirector.reducedMotion ? 'play' : 'pause')} Animations: ${motionDirector.reducedMotion ? 'Reduced' : 'On'}`,
      'motion',
      'btn-sm',
      `aria-pressed="${!motionDirector.reducedMotion}" aria-label="${motionDirector.reducedMotion ? 'Enable full animations' : 'Reduce animations'}" title="${motionDirector.reducedMotion ? 'Enable troop movements, missiles and casualty effects' : 'Use reduced motion'}"`,
    );
  };

  function showHelp() {
    const dialog = document.getElementById('help-dialog');
    dialog.innerHTML = /* HTML */ `<div class="help-head"
        ><div
          ><div class="eyebrow">Rules of engagement</div
          ><h2 id="help-title">A world under your command.</h2></div
        ><button class="icon-button" data-action="close-help" aria-label="Close instructions"
          >${renderIcon('close')}</button
        ></div
      ><div class="help-content"
        >${[
          [
            'Choose your foothold',
            'Start with one country. Nine other countries are assigned to strategic NPCs. The first participant is chosen randomly.',
          ],
          [
            'Reinforce and reposition',
            'From round two, receive two soldiers per controlled country at the start of your turn. Move soldiers between your countries while leaving one behind.',
          ],
          [
            'Choose your target',
            'Attack any enemy country from an owned country with at least two soldiers. You have one attack against one target per turn.',
          ],
          [
            'Let the dice decide',
            'Both sides roll as many paired dice as the smaller available force. Attackers leave one soldier behind. The higher roll defeats one soldier; ties cause no loss.',
          ],
          [
            'Know when to stop',
            'Continue rolling, stop and end your turn, or conquer the target. The attack also ends when the attacker has only one soldier.',
          ],
          [
            'Conquer the world',
            'Conquest earns max(2, half the country’s original strength rounded down). Control all ten countries to win.',
          ],
        ]
          .map(
            ([title, text], i) =>
              /* HTML */ `<div class="help-step"
                ><span>0${i + 1}</span><div><h3>${title}</h3><p>${text}</p></div></div
              >`,
          )
          .join('')}<div class="notice"
          >${renderIcon('info')}<span
            >Starting armies use a validated Worldometers population snapshot. Existing campaigns
            keep their original populations and rewards.
            ${cloudEnabled ? 'Sign in to play and sync your campaigns.' : 'Account screens preview the future sign-in flow.'}</span
          ></div
        ></div
      >`;
    if (!dialog.open) dialog.showModal();
  }
  return { nav, footer, motionControl, showHelp };
}
