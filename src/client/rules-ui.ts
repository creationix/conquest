import { closeDialog, h, openDialog } from './dom.ts';

export function showRules() {
  const dlg = h('dialog.rules') as HTMLDialogElement;
  const close = () => closeDialog(dlg);
  dlg.innerHTML = `
    <div class="row"><h2 style="margin:0">How to play</h2><span class="spacer"></span></div>
    <p>Conquest is a game of land, wealth and war for 2 to 7 lords. Be the first to own enough
    <b>cities</b> (3 by default) at the end of a year. Cities you capture count too.</p>

    <h3>Choosing lands</h3>
    <p>Players take turns claiming territories until the map is full. Lands with resource sites
    (gold, iron, coal, timber, horses) are the most valuable; lands next to your own are easier to defend.</p>

    <h3>Each year</h3>
    <ol>
      <li><b>Development</b> (from year 2): spend your stockpile on cities, weapons and boats.</li>
      <li><b>Production</b>: every resource site you own adds to your stockpile. A city doubles the production
      of its land and your neighboring lands. Pastures breed horses, which spread across your land.
      In the first year, everyone places their <b>stockpile</b>: lose that land and the conqueror takes it all.</li>
      <li><b>Trading</b> (3+ players): make deals out loud, then record them. Nothing is binding!</li>
      <li><b>Shipment</b>: move your stockpile somewhere safer (Expert: or move a weapon, horse or boat).</li>
      <li><b>Conquest</b>: each lord may attack twice. The second attack may instead move the stockpile.</li>
    </ol>
    <p>With medium or high chance, production, trading and shipment may be skipped some years.</p>

    <h3>Costs</h3>
    <table>
      <tr><th></th><th>Gold</th><th>Or goods (Intermediate+)</th></tr>
      <tr><td>Weapon</td><td>2 gold</td><td>1 iron + 1 coal</td></tr>
      <tr><td>City</td><td>4 gold</td><td>1 gold + 1 iron + 1 coal + 1 timber</td></tr>
      <tr><td>Boat (Advanced+)</td><td>3 gold</td><td>3 timber</td></tr>
    </table>
    <p>Only one city, one weapon and one horse fit in a territory.</p>

    <h3>Battle</h3>
    <p>Defense of a territory: <b>1</b> for the land itself, plus <b>1</b> for each bordering land of the same owner.
    Horses add <b>1</b>, cities <b>2</b>, weapons <b>3</b> (in the land and in its bordering lands of the same owner),
    and each boat in the land adds <b>2</b>.</p>
    <p>Attack: <b>1</b> for each of your lands bordering the target, plus the horses, cities and weapons in them.
    You can bring one extra force: a <b>horse</b> from two lands away (it may pick up a weapon on the way),
    or a <b>boat</b> (+2) that may carry a horse and a weapon across the water. Boats let you attack lands you do not border.</p>
    <p>Other lords with forces next to the target choose to help the attacker, help the defender, or stay out.</p>
    <p><b>Chance:</b> Low: the stronger side always wins, ties go to the attacker. Medium: ties are a coin toss.
    High: odds are in proportion to strength, so long shots can win. If you lose (medium or high), anything you brought is lost
    and your turn ends.</p>
    <p>Win a battle and you take everything in the land: its site, city, weapon, horse, boats and even a stockpile.</p>

    <h3>Levels</h3>
    <p><b>Beginner:</b> only gold and horses. <b>Intermediate:</b> all five resources. <b>Advanced:</b> adds boats.
    <b>Expert:</b> weapons, horses and boats can also be shipped.</p>

    <h3>Playing together</h3>
    <p>Pass one device around, or connect several phones, tablets and laptops to a Conquest server on your Wi-Fi.
    Each device plays the seats it claimed and watches the rest. A device can play several seats, so families can mix both.</p>
    <div class="row" style="margin-top:16px"><span class="spacer"></span><button class="primary" id="rules-close">Got it</button></div>
  `;
  dlg.querySelector('#rules-close')!.addEventListener('click', close);
  dlg.addEventListener('close', () => dlg.remove());
  openDialog(dlg);
}
