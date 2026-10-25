/* eslint-disable @typescript-eslint/restrict-template-expressions -- numbers are formatted into test texts */
/**
 * A broad corpus for the content matcher: ~165 invented governance rules from 20 departments, in
 * French and English, with numbers (percent, amount, count) and without (forbidden terms), and
 * for each rule a set of labelled texts. The rules are DATA; the texts are generated from a few
 * realistic structures (sentence, JSON, table row, list item, reversed form...) so that every
 * rule is hit the same way and a weakness of the matcher shows as a pattern, not an accident.
 *
 * Not part of the build (tsconfig.build.json leaves src/testing out).
 */
import type { ContentRule, ContentScope } from '../content.js';

export type Verdict = 'violation' | 'ambiguous' | 'none';
export type Expect = Verdict | readonly Verdict[];
export type Lang = 'fr' | 'en';
export type Category = 'violation' | 'compliant' | 'other-subject' | 'ambiguous' | 'edge';

export interface Sample {
  readonly text: string;
  readonly expect: Expect;
  readonly category: Category;
  readonly note: string;
}

export interface Case {
  readonly dept: string;
  readonly lang: Lang;
  readonly rule: ContentRule;
  readonly samples: readonly Sample[];
}

const cap = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);
const group = (value: number, separator: string): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, separator);

// -------------------------------------------------------------- numeric rules

type Unit = 'percent' | 'amount' | 'count';
type Op = 'lt' | 'lte' | 'gt' | 'gte';

interface Num {
  readonly dept: string;
  readonly lang: Lang;
  readonly id: string;
  readonly decision: 'forbid' | 'ask';
  readonly scopes: readonly ContentScope[];
  /** The word(s) that name the subject, first one is used in the generated texts. */
  readonly aliases: readonly string[];
  readonly unit: Unit;
  readonly op: Op;
  readonly limit: number;
  readonly cur?: 'EUR' | 'USD' | 'GBP';
  /** Another subject that can carry the same kind of number. */
  readonly other: string;
  readonly text: string;
  readonly reason: string;
  readonly alts: readonly string[];
}

const ALL: readonly ContentScope[] = ['prompt', 'file_write', 'answer'];
const FILE: readonly ContentScope[] = ['file_write'];

const n = (
  dept: string,
  lang: Lang,
  id: string,
  aliases: readonly string[],
  unit: Unit,
  op: Op,
  limit: number,
  other: string,
  text: string,
  alts: readonly string[],
  extra: {
    cur?: 'EUR' | 'USD' | 'GBP';
    decision?: 'forbid' | 'ask';
    scopes?: readonly ContentScope[];
  } = {},
): Num => ({
  dept,
  lang,
  id,
  decision: extra.decision ?? 'forbid',
  scopes: extra.scopes ?? ALL,
  aliases,
  unit,
  op,
  limit,
  ...(extra.cur === undefined ? {} : { cur: extra.cur }),
  other,
  text,
  reason: text,
  alts,
});

// prettier-ignore
export const NUMERIC: readonly Num[] = [
  // ---- sales & tenders
  n('sales', 'fr', 'sales-discount-cap', ['remise', 'rabais'], 'percent', 'lte', 5, 'productivité', 'La remise accordée sur un appel d’offres ne dépasse jamais 5 %.', ['Proposer un délai de paiement plus long', 'Proposer un palier de volume'],),
  n('sales', 'en', 'sales-discount-cap-en', ['discount', 'rebate'], 'percent', 'lte', 5, 'growth', 'A tender discount never exceeds 5%.', ['Offer a longer payment term', 'Offer a volume tier'],),
  n('sales', 'fr', 'sales-commission-cap', ['commission'], 'percent', 'lte', 8, 'croissance', 'La commission d’un commercial est plafonnée à 8 %.', ['Utiliser une prime d’équipe'],),
  n('sales', 'en', 'sales-margin-floor', ['margin', 'gross margin'], 'percent', 'gte', 25, 'discount', 'The gross margin on a quote never falls below 25%.', ['Raise the unit price', 'Remove optional services'],),
  n('sales', 'fr', 'sales-margin-floor-fr', ['marge', 'marge brute'], 'percent', 'gte', 20, 'remise', 'La marge brute d’une offre ne descend jamais sous 20 %.', ['Revoir le périmètre', 'Augmenter le prix unitaire'],),
  n('sales', 'en', 'sales-payment-terms', ['payment terms', 'payment term'], 'count', 'lte', 60, 'warranty', 'Payment terms never exceed 60 days.', ['Offer a 2% early-payment discount'],),
  n('sales', 'fr', 'sales-deal-approval', ['montant du contrat', 'contrat'], 'amount', 'lte', 100000, 'chiffre d’affaires', 'Un contrat de plus de 100 000 € exige une validation du directeur commercial.', ['Demander la validation du directeur'], { cur: 'EUR', decision: 'ask' },),
  n('sales', 'en', 'sales-free-licences', ['free licences', 'free licenses'], 'count', 'lte', 10, 'paid seats', 'No more than 10 free licences per prospect.', ['Offer a 30-day trial'],),
  // ---- public tenders
  n('tenders', 'fr', 'tender-page-limit', ['pages'], 'count', 'lte', 30, 'diapositives', 'Un mémoire technique ne dépasse pas 30 pages.', ['Déplacer le détail en annexe'],),
  n('tenders', 'en', 'tender-word-limit', ['words'], 'count', 'lte', 2000, 'pages', 'An executive summary never exceeds 2,000 words.', ['Move detail to an appendix'],),
  n('tenders', 'fr', 'tender-bid-ceiling', ['offre de prix', 'prix de l’offre'], 'amount', 'lte', 250000, 'budget client', 'Une offre de prix dépassant 250 000 € nécessite l’accord de la direction.', ['Découper en lots'], { cur: 'EUR', decision: 'ask' },),
  n('tenders', 'en', 'tender-references', ['references', 'customer references'], 'count', 'gte', 3, 'pages', 'Every bid includes at least 3 customer references.', ['Add a case study'],),
  n('tenders', 'fr', 'tender-validity', ['validité de l’offre', 'validité'], 'count', 'lte', 90, 'jours de livraison', 'La validité d’une offre ne dépasse pas 90 jours.', ['Prévoir une clause de révision de prix'],),
  n('tenders', 'en', 'tender-penalty', ['late penalty', 'penalty'], 'percent', 'lte', 10, 'tax', 'Contractual late penalties are capped at 10% of the order value.', ['Use a service-credit scheme'],),
  // ---- marketing & brand
  n('marketing', 'fr', 'mkt-promo-cap', ['promotion', 'promo'], 'percent', 'lte', 30, 'engagement', 'Une promotion publique ne dépasse pas 30 %.', ['Proposer un produit offert'],),
  n('marketing', 'en', 'mkt-post-length', ['characters', 'character'], 'count', 'lte', 280, 'followers', 'A social post stays under 280 characters.', ['Link to a longer page'],),
  n('marketing', 'fr', 'mkt-slides', ['diapositives', 'slides'], 'count', 'lte', 20, 'pages', 'Une présentation commerciale ne dépasse pas 20 diapositives.', ['Créer un document d’appui'],),
  n('marketing', 'en', 'mkt-campaign-budget', ['campaign budget', 'media budget'], 'amount', 'lte', 50000, 'revenue', 'A campaign budget above $50,000 needs CMO approval.', ['Ask for CMO approval'], { cur: 'USD', decision: 'ask' },),
  n('marketing', 'fr', 'mkt-influencer-fee', ['cachet', 'rémunération de l’influenceur'], 'amount', 'lte', 3000, 'portée', 'Le cachet d’un influenceur ne dépasse pas 3 000 €.', ['Proposer un échange de produits'], { cur: 'EUR' },),
  n('marketing', 'en', 'mkt-email-frequency', ['emails per week', 'weekly emails'], 'count', 'lte', 2, 'subscribers', 'Never send more than 2 emails per week to the same contact.', ['Merge into a weekly digest'],),
  n('marketing', 'fr', 'mkt-seo-density', ['densité de mots-clés', 'densité'], 'percent', 'lte', 3, 'taux de rebond', 'La densité de mots-clés d’une page reste sous 3 %.', ['Utiliser des synonymes'],),
  // ---- legal & contracts
  n('legal', 'en', 'legal-liability-cap', ['liability cap', 'liability'], 'amount', 'lte', 1000000, 'revenue', 'Contractual liability is capped at £1,000,000.', ['Insert the standard liability clause'], { cur: 'GBP' },),
  n('legal', 'fr', 'legal-notice-period', ['préavis'], 'count', 'lte', 90, 'jours fériés', 'Le préavis contractuel ne dépasse pas 90 jours.', ['Utiliser la clause type de résiliation'],),
  n('legal', 'en', 'legal-term-length', ['contract term', 'term'], 'count', 'lte', 36, 'invoices', 'A customer contract term never exceeds 36 months.', ['Use renewal options'],),
  n('legal', 'fr', 'legal-interest-rate', ['intérêts de retard', 'taux d’intérêt'], 'percent', 'lte', 12, 'inflation', 'Le taux d’intérêts de retard est limité à 12 %.', ['Appliquer le taux légal'],),
  n('legal', 'en', 'legal-nda-years', ['confidentiality period', 'nda term'], 'count', 'lte', 5, 'meetings', 'The confidentiality period of an NDA never exceeds 5 years.', ['Use the standard NDA'],),
  n('legal', 'fr', 'legal-signature', ['seuil de signature', 'signature'], 'amount', 'lte', 20000, 'budget', 'Un juriste ne signe pas seul au-delà de 20 000 €.', ['Demander une co-signature'], { cur: 'EUR', decision: 'ask' },),
  // ---- HR & recruitment
  n('hr', 'fr', 'hr-salary-offer', ['salaire proposé', 'salaire'], 'amount', 'lte', 60000, 'prime', 'Une offre de salaire au-dessus de 60 000 € demande l’accord de la DRH.', ['Passer par la grille salariale'], { cur: 'EUR', decision: 'ask' },),
  n('hr', 'en', 'hr-interview-rounds', ['interview rounds', 'rounds'], 'count', 'lte', 4, 'candidates', 'A recruitment process has at most 4 interview rounds.', ['Combine two rounds'],),
  n('hr', 'fr', 'hr-probation', ['période d’essai', 'essai'], 'count', 'lte', 4, 'formations', 'La période d’essai ne dépasse pas 4 mois.', ['Prévoir un point à 3 mois'],),
  n('hr', 'en', 'hr-bonus-cap', ['bonus', 'annual bonus'], 'percent', 'lte', 20, 'turnover', 'The annual bonus is capped at 20% of base salary.', ['Use a one-off recognition award'],),
  n('hr', 'fr', 'hr-remote-days', ['jours de télétravail', 'télétravail'], 'count', 'lte', 3, 'jours de congé', 'Le télétravail est limité à 3 jours par semaine.', ['Organiser un jour d’équipe sur site'],),
  n('hr', 'en', 'hr-referral-fee', ['referral bonus', 'referral fee'], 'amount', 'lte', 2500, 'salary', 'A referral bonus never exceeds £2,500.', ['Offer extra leave'], { cur: 'GBP' },),
  n('hr', 'fr', 'hr-job-ad', ['mots', 'mots de l’annonce'], 'count', 'lte', 400, 'candidats', 'Une annonce d’emploi reste sous 400 mots.', ['Lien vers la fiche de poste complète'],),
  // ---- finance & expenses
  n('finance', 'en', 'fin-meal-expense', ['meal allowance', 'meal expense', 'meal'], 'amount', 'lte', 40, 'hotel', 'A single meal expense stays under $40 per person.', ['Use the staff canteen'], { cur: 'USD' },),
  n('finance', 'fr', 'fin-hotel-night', ['nuit d’hôtel', 'hôtel'], 'amount', 'lte', 150, 'taxis', 'Une nuit d’hôtel ne dépasse pas 150 € en province.', ['Réserver via l’agence agréée'], { cur: 'EUR' },),
  n('finance', 'en', 'fin-purchase-approval', ['purchase order', 'po value'], 'amount', 'lte', 10000, 'budget', 'A purchase over $10,000 requires finance approval.', ['Submit a PO request'], { cur: 'USD', decision: 'ask' },),
  n('finance', 'fr', 'fin-vat-note', ['TVA'], 'percent', 'lte', 20, 'marge', 'Les devis ne mentionnent jamais une TVA supérieure à 20 %.', ['Utiliser le taux en vigueur'],),
  n('finance', 'en', 'fin-forecast-growth', ['growth forecast', 'forecast growth'], 'percent', 'lte', 15, 'costs', 'Board forecasts never assume growth above 15% a year.', ['Show a base and an upside case'],),
  n('finance', 'fr', 'fin-cash-buffer', ['trésorerie disponible', 'trésorerie'], 'amount', 'gte', 200000, 'créances', 'La trésorerie disponible ne descend pas sous 200 000 €.', ['Reporter l’investissement'], { cur: 'EUR' },),
  n('finance', 'en', 'fin-per-diem', ['per diem'], 'amount', 'lte', 75, 'mileage', 'A travel per diem is limited to £75 a day.', ['Claim actual receipts'], { cur: 'GBP' },),
  n('finance', 'fr', 'fin-corporate-card', ['carte bancaire', 'carte'], 'amount', 'lte', 500, 'remboursements', 'Un paiement par carte d’entreprise ne dépasse pas 500 €.', ['Passer par un bon de commande'], { cur: 'EUR' },),
  // ---- procurement
  n('procurement', 'en', 'proc-supplier-share', ['single supplier', 'supplier share'], 'percent', 'lte', 40, 'savings', 'No supplier may represent more than 40% of a category spend.', ['Qualify a second supplier'],),
  n('procurement', 'fr', 'proc-quotes', ['devis comparatifs', 'devis'], 'count', 'gte', 3, 'fournisseurs', 'Tout achat important compare au moins 3 devis.', ['Lancer une consultation'],),
  n('procurement', 'en', 'proc-contract-value', ['framework value', 'framework agreement'], 'amount', 'lte', 500000, 'volume', 'A framework agreement above €500,000 needs a tender.', ['Run a tender'], { cur: 'EUR', decision: 'ask' },),
  n('procurement', 'fr', 'proc-delivery-delay', ['délai de livraison'], 'count', 'lte', 30, 'prix', 'Le délai de livraison fournisseur ne dépasse pas 30 jours.', ['Prévoir un stock tampon'],),
  n('procurement', 'en', 'proc-advance-payment', ['advance payment', 'prepayment'], 'percent', 'lte', 30, 'discount', 'Advance payments never exceed 30% of the order.', ['Pay on milestones'],),
  // ---- IT & security
  n('it', 'en', 'it-password-length', ['password length', 'password'], 'count', 'gte', 14, 'accounts', 'Passwords have at least 14 characters.', ['Use the password manager'],),
  n('it', 'fr', 'it-session-timeout', ['durée de session', 'session'], 'count', 'lte', 30, 'utilisateurs', 'Une session inactive est fermée après 30 minutes au plus.', ['Activer la reconnexion silencieuse'],),
  n('it', 'en', 'it-login-attempts', ['login attempts', 'failed attempts'], 'count', 'lte', 5, 'users', 'An account is locked after at most 5 failed login attempts.', ['Enable MFA'],),
  n('it', 'fr', 'it-backup-retention', ['rétention des sauvegardes', 'rétention'], 'count', 'gte', 30, 'serveurs', 'Les sauvegardes sont conservées au moins 30 jours.', ['Utiliser la politique standard'],),
  n('it', 'en', 'it-cloud-spend', ['monthly cloud spend', 'cloud spend'], 'amount', 'lte', 20000, 'traffic', 'Monthly cloud spend above $20,000 needs approval.', ['Open a FinOps review'], { cur: 'USD', decision: 'ask' },),
  n('it', 'fr', 'it-disk-usage', ['occupation du disque', 'disque'], 'percent', 'lte', 85, 'CPU', 'L’occupation du disque ne dépasse pas 85 %.', ['Archiver les anciens volumes'],),
  n('it', 'en', 'it-licences-per-user', ['licences per user', 'licenses per user'], 'count', 'lte', 2, 'devices', 'A user gets at most 2 software licences.', ['Request a shared licence'],),
  // ---- software engineering
  n('eng', 'en', 'eng-coverage', ['test coverage', 'coverage'], 'percent', 'gte', 80, 'bugs', 'Test coverage of a service never falls below 80%.', ['Add tests before merging'],),
  n('eng', 'fr', 'eng-pr-size', ['lignes modifiées', 'lignes'], 'count', 'lte', 400, 'commentaires', 'Une pull request ne dépasse pas 400 lignes modifiées.', ['Découper en plusieurs PR'],),
  n('eng', 'en', 'eng-function-length', ['lines per function', 'function length'], 'count', 'lte', 60, 'files', 'A function stays under 60 lines.', ['Extract a helper'],),
  n('eng', 'fr', 'eng-latency', ['latence p95', 'latence'], 'count', 'lte', 300, 'requêtes', 'La latence p95 d’une API ne dépasse pas 300 ms.', ['Ajouter un cache'],),
  n('eng', 'en', 'eng-deps', ['dependencies', 'direct dependencies'], 'count', 'lte', 40, 'tests', 'A service has at most 40 direct dependencies.', ['Remove unused packages'],),
  n('eng', 'fr', 'eng-error-budget', ['budget d’erreur'], 'percent', 'lte', 1, 'disponibilité', 'Le budget d’erreur mensuel ne dépasse pas 1 %.', ['Geler les déploiements'],),
  n('eng', 'en', 'eng-review-approvals', ['approvals', 'reviewers'], 'count', 'gte', 2, 'comments', 'Every merge needs at least 2 approvals.', ['Ask a second reviewer'],),
  // ---- customer support
  n('support', 'fr', 'sup-refund', ['remboursement'], 'amount', 'lte', 200, 'tickets', 'Un agent rembourse au plus 200 € sans accord du responsable.', ['Escalader au responsable'], { cur: 'EUR', decision: 'ask' },),
  n('support', 'en', 'sup-response-time', ['response time', 'first response'], 'count', 'lte', 24, 'tickets', 'The first response time never exceeds 24 hours.', ['Use the auto-acknowledgement'],),
  n('support', 'fr', 'sup-goodwill', ['geste commercial', 'geste'], 'percent', 'lte', 10, 'satisfaction', 'Un geste commercial ne dépasse pas 10 % de la commande.', ['Offrir un bon d’achat'],),
  n('support', 'en', 'sup-reply-length', ['sentences', 'reply length'], 'count', 'lte', 8, 'tickets', 'A customer reply stays under 8 sentences.', ['Link to the help article'],),
  n('support', 'fr', 'sup-credit', ['avoir', 'crédit client'], 'amount', 'lte', 300, 'satisfaction', 'Un avoir client ne dépasse pas 300 €.', ['Demander l’accord du responsable'], { cur: 'EUR', decision: 'ask' },),
  // ---- compliance, ESG, privacy
  n('compliance', 'en', 'comp-gift', ['gift value', 'gift'], 'amount', 'lte', 100, 'dinner', 'Gifts to public officials never exceed £100.', ['Decline politely'], { cur: 'GBP' },),
  n('compliance', 'fr', 'comp-retention', ['durée de conservation', 'conservation'], 'count', 'lte', 36, 'dossiers', 'Les données personnelles ne sont pas conservées plus de 36 mois.', ['Anonymiser les données'],),
  n('compliance', 'en', 'comp-carbon', ['carbon intensity', 'emissions'], 'percent', 'lte', 20, 'savings', 'Emissions claims never state a reduction above 20% without audit.', ['Cite the audited figure'],),
  n('compliance', 'fr', 'comp-cookies', ['durée des cookies', 'cookies'], 'count', 'lte', 13, 'visiteurs', 'La durée de vie d’un cookie ne dépasse pas 13 mois.', ['Utiliser un cookie de session'],),
  n('compliance', 'en', 'comp-pep', ['donation', 'political donation'], 'amount', 'lte', 0, 'budget', 'No political donation of any amount without legal approval.', ['Ask legal'], { cur: 'USD', decision: 'ask' },),
  n('compliance', 'fr', 'comp-recycled', ['matière recyclée', 'recyclé'], 'percent', 'lte', 60, 'coût', 'Une allégation de matière recyclée ne dépasse pas 60 % sans certificat.', ['Joindre le certificat'],),
  // ---- operations & logistics
  n('ops', 'en', 'ops-stock-cover', ['stock cover', 'inventory cover'], 'count', 'lte', 45, 'orders', 'Inventory cover never exceeds 45 days.', ['Reduce the reorder quantity'],),
  n('ops', 'fr', 'ops-overtime', ['heures supplémentaires'], 'count', 'lte', 10, 'équipes', 'Les heures supplémentaires restent sous 10 heures par semaine.', ['Embaucher un intérimaire'],),
  n('ops', 'en', 'ops-load-factor', ['load factor', 'truck load'], 'percent', 'gte', 85, 'delivery', 'A truck leaves at no less than 85% load.', ['Wait for a consolidated load'],),
  n('ops', 'fr', 'ops-shipping-cost', ['frais de port', 'port'], 'amount', 'lte', 25, 'colis', 'Les frais de port ne dépassent pas 25 € par colis.', ['Grouper les envois'], { cur: 'EUR' },),
  n('ops', 'en', 'ops-defect-rate', ['defect rate', 'defects'], 'percent', 'lte', 2, 'volume', 'The defect rate of a shipped batch is below 2%.', ['Hold the batch for inspection'],),
  // ---- R&D
  n('rnd', 'fr', 'rnd-prototype-budget', ['budget du prototype', 'prototype'], 'amount', 'lte', 40000, 'brevets', 'Un prototype coûte au plus 40 000 € sans comité.', ['Présenter au comité R&D'], { cur: 'EUR', decision: 'ask' },),
  n('rnd', 'en', 'rnd-trial-size', ['participants', 'trial size'], 'count', 'lte', 50, 'sites', 'A pilot trial has at most 50 participants.', ['Start with a smaller cohort'],),
  n('rnd', 'fr', 'rnd-accuracy-claim', ['précision annoncée', 'précision'], 'percent', 'lte', 95, 'rappel', 'Une précision annoncée au client ne dépasse pas 95 % sans validation.', ['Citer l’intervalle de confiance'],),
  n('rnd', 'en', 'rnd-gpu-hours', ['gpu hours', 'compute hours'], 'count', 'lte', 500, 'models', 'An experiment uses at most 500 GPU hours.', ['Use a smaller model'],),
  // ---- communications & PR
  n('pr', 'fr', 'pr-press-words', ['mots du communiqué', 'communiqué'], 'count', 'lte', 350, 'journalistes', 'Un communiqué de presse reste sous 350 mots.', ['Joindre un dossier de presse'],),
  n('pr', 'en', 'pr-spokesperson', ['quotes', 'quote'], 'count', 'lte', 2, 'journalists', 'A press release contains at most 2 executive quotes.', ['Use a fact sheet'],),
  n('pr', 'fr', 'pr-sponsoring', ['sponsoring', 'parrainage'], 'amount', 'lte', 15000, 'audience', 'Un sponsoring supérieur à 15 000 € passe en comité.', ['Présenter au comité communication'], { cur: 'EUR', decision: 'ask' },),
  n('pr', 'en', 'pr-claim-superlative', ['market share', 'share of market'], 'percent', 'lte', 30, 'growth', 'Public material never states a market share above 30% without a source.', ['Cite the analyst report'],),
  // ---- health & safety
  n('hse', 'en', 'hse-shift-length', ['shift length', 'shift'], 'count', 'lte', 10, 'workers', 'A shift never exceeds 10 hours.', ['Add a relief crew'],),
  n('hse', 'fr', 'hse-noise', ['niveau sonore', 'bruit'], 'count', 'lte', 85, 'machines', 'Le niveau sonore d’un poste ne dépasse pas 85 dB.', ['Fournir une protection auditive'],),
  n('hse', 'en', 'hse-lifting', ['lifting limit', 'manual lifting'], 'count', 'lte', 25, 'boxes', 'Manual lifting is limited to 25 kg per person.', ['Use the hoist'],),
  n('hse', 'fr', 'hse-occupancy', ['capacité de la salle', 'occupation'], 'count', 'lte', 50, 'réunions', 'La capacité d’une salle ne dépasse pas 50 personnes.', ['Utiliser la grande salle'],),
  // ---- education & training
  n('training', 'en', 'trn-session-hours', ['training hours', 'course length'], 'count', 'lte', 7, 'attendees', 'A training day is at most 7 hours.', ['Split over two days'],),
  n('training', 'fr', 'trn-group-size', ['stagiaires', 'participants'], 'count', 'lte', 12, 'formateurs', 'Un groupe de formation compte au plus 12 stagiaires.', ['Ouvrir une seconde session'],),
  n('training', 'en', 'trn-course-fee', ['course fee', 'tuition'], 'amount', 'lte', 3000, 'seats', 'A course fee above $3,000 needs HR approval.', ['Ask HR'], { cur: 'USD', decision: 'ask' },),
  n('training', 'fr', 'trn-pass-rate', ['taux de réussite', 'réussite'], 'percent', 'lte', 98, 'satisfaction', 'Un taux de réussite affiché ne dépasse pas 98 % sans audit.', ['Publier la méthode de calcul'],),
  // ---- real estate
  n('realestate', 'fr', 're-rent-increase', ['augmentation du loyer', 'loyer'], 'percent', 'lte', 3, 'charges', 'L’augmentation annuelle d’un loyer ne dépasse pas 3 %.', ['Appliquer l’indice officiel'],),
  n('realestate', 'en', 're-deposit', ['security deposit', 'deposit'], 'count', 'lte', 2, 'tenants', 'A security deposit is at most 2 months of rent.', ['Offer a bank guarantee'],),
  n('realestate', 'fr', 're-agency-fee', ['honoraires', 'frais d’agence'], 'percent', 'lte', 6, 'prix de vente', 'Les honoraires d’agence ne dépassent pas 6 % du prix.', ['Proposer un forfait'],),
  n('realestate', 'en', 're-lease-area', ['square metres', 'floor area'], 'count', 'lte', 500, 'tenants', 'A standard lease covers at most 500 square metres.', ['Use the large-tenant template'],),
  // ---- healthcare-adjacent administration
  n('health', 'fr', 'hlth-copay', ['reste à charge', 'participation'], 'amount', 'lte', 50, 'patients', 'Le reste à charge annoncé ne dépasse pas 50 € sans accord.', ['Vérifier avec la mutuelle'], { cur: 'EUR', decision: 'ask' },),
  n('health', 'en', 'hlth-wait-time', ['waiting time', 'wait'], 'count', 'lte', 14, 'appointments', 'Communications promise a waiting time of at most 14 days.', ['Offer the nearest slot'],),
  n('health', 'fr', 'hlth-efficacy', ['efficacité', 'efficacité annoncée'], 'percent', 'lte', 90, 'dosage', 'Aucune efficacité supérieure à 90 % n’est annoncée sans étude.', ['Citer l’étude clinique'],),
  // ---- customer success / partners / data
  n('partners', 'en', 'prt-reseller-margin', ['reseller margin', 'partner margin'], 'percent', 'lte', 20, 'volume', 'Reseller margin is capped at 20%.', ['Offer a volume rebate'],),
  n('partners', 'fr', 'prt-mdf', ['budget marketing partenaire', 'MDF'], 'amount', 'lte', 10000, 'ventes', 'Le budget marketing d’un partenaire ne dépasse pas 10 000 €.', ['Co-financer à 50 %'], { cur: 'EUR' },),
  n('data', 'en', 'dat-sample', ['sample size', 'sample'], 'count', 'gte', 1000, 'rows', 'A published survey result needs a sample of at least 1,000 respondents.', ['State the margin of error'],),
  n('data', 'fr', 'dat-null-rate', ['taux de valeurs nulles', 'valeurs nulles'], 'percent', 'lte', 5, 'colonnes', 'Un jeu de données publié a moins de 5 % de valeurs nulles.', ['Documenter les valeurs manquantes'],),
  n('data', 'en', 'dat-export', ['records per export', 'export size'], 'count', 'lte', 10000, 'columns', 'A data export contains at most 10,000 records.', ['Request a batch export'], { decision: 'ask' },),
  n('customer-success', 'fr', 'cs-renewal-discount', ['remise de renouvellement', 'renouvellement'], 'percent', 'lte', 7, 'churn', 'Une remise de renouvellement ne dépasse pas 7 %.', ['Proposer un module offert'],),
  n('customer-success', 'en', 'cs-onboarding-days', ['onboarding', 'onboarding time'], 'count', 'lte', 30, 'accounts', 'Onboarding is promised within 30 days.', ['Offer a kickoff workshop'],),
];

// ------------------------------------------------------------- text generation

function rule(spec: Num): ContentRule {
  const common = {
    id: spec.id,
    kind: 'content' as const,
    decision: spec.decision,
    reason: spec.reason,
    required: true,
    topic: spec.dept,
    text: spec.text,
    subject_aliases: spec.aliases,
    scopes: spec.scopes,
    alternatives: spec.alts,
  };
  return {
    ...common,
    constraint: {
      kind: 'number_bound',
      operator: spec.op,
      limit: String(spec.limit),
      unit: spec.unit,
      ...(spec.cur === undefined ? {} : { currency: spec.cur }),
      binding_window: 6,
    },
  };
}

/** Values on each side of the bound, whatever the direction of the rule. */
function values(spec: Num): { bad: number; good: number } {
  switch (spec.op) {
    case 'lte':
      return { bad: spec.limit === 0 ? 100 : spec.limit * 2, good: Math.max(spec.limit - 1, 0) };
    case 'lt':
      return { bad: spec.limit, good: Math.max(spec.limit - 1, 0) };
    case 'gte':
      return { bad: Math.max(Math.floor(spec.limit / 2), 0), good: spec.limit + 5 };
    default:
      return { bad: spec.limit, good: spec.limit + 1 };
  }
}

const SYMBOL: Record<
  string,
  { fr: (v: number) => string; en: (v: number) => string; before: (v: number) => string }
> = {
  EUR: {
    fr: (v) => `${group(v, ' ')} €`,
    en: (v) => `${group(v, ',')} EUR`,
    before: (v) => `€${group(v, ',')}`,
  },
  USD: {
    fr: (v) => `${group(v, ' ')} USD`,
    en: (v) => `${group(v, ',')} USD`,
    before: (v) => `$${group(v, ',')}`,
  },
  GBP: {
    fr: (v) => `${group(v, ' ')} GBP`,
    en: (v) => `${group(v, ',')} GBP`,
    before: (v) => `£${group(v, ',')}`,
  },
};

function numericSamples(spec: Num): Sample[] {
  const fr = spec.lang === 'fr';
  const label = spec.aliases[0] ?? '';
  const second = spec.aliases[1] ?? label;
  const { bad, good } = values(spec);
  const show = (v: number): string => {
    if (spec.unit === 'percent') return fr ? `${v} %` : `${v}%`;
    if (spec.unit === 'amount')
      return (
        (fr ? SYMBOL[spec.cur ?? 'EUR']?.fr(v) : SYMBOL[spec.cur ?? 'EUR']?.en(v)) ?? String(v)
      );
    return String(v);
  };
  const of = fr ? 'de' : 'of';
  const out: Sample[] = [];
  const add = (category: Category, expect: Expect, text: string, note: string): void => {
    out.push({ text, expect, category, note });
  };

  // violations in different structures
  if (spec.unit === 'count') {
    add('violation', 'violation', `${bad} ${label}`, 'value then unit noun');
    add('violation', 'violation', `${cap(label)} : ${bad}`, 'subject colon value');
    add(
      'violation',
      'violation',
      fr ? `Le document prévoit ${bad} ${second}.` : `The document plans ${bad} ${second}.`,
      'inside a sentence',
    );
  } else {
    add(
      'violation',
      'violation',
      fr ? `${cap(label)} ${of} ${show(bad)}.` : `${cap(label)} ${of} ${show(bad)}.`,
      'plain sentence',
    );
    add(
      'violation',
      'violation',
      `${cap(second)} ${fr ? 'à' : 'at'} ${show(bad)}`,
      'second alias, preposition',
    );
    add(
      'violation',
      'violation',
      fr ? `${show(bad)} de ${label}` : `${show(bad)} ${label}`,
      'reversed form',
    );
  }
  add('violation', 'violation', `{"${label}": "${show(bad)}"}`, 'JSON key and quoted value');
  add('violation', 'violation', `| ${cap(label)} | ${show(bad)} |`, 'markdown table row');
  add('violation', 'violation', `- ${cap(label)} : ${show(bad)}`, 'list item');
  // compliant
  add(
    'compliant',
    'none',
    spec.unit === 'count' ? `${good} ${label}` : `${cap(label)} ${of} ${show(good)}.`,
    'inside the bound',
  );
  add('compliant', 'none', `{"${label}": "${show(good)}"}`, 'JSON inside the bound');
  // the same number for another subject (the founder's case)
  const o = spec.other;
  if (spec.unit === 'count') {
    add('other-subject', 'none', `${bad} ${o}`, 'same number, other noun');
  } else {
    add(
      'other-subject',
      'none',
      fr ? `${cap(o)} ${of} ${show(bad)} cette année.` : `${cap(o)} ${of} ${show(bad)} this year.`,
      'same value, other subject',
    );
  }
  add('other-subject', 'none', `| ${cap(o)} | ${show(bad)} |`, 'table row of another subject');
  add(
    'other-subject',
    ['none', 'ambiguous'],
    fr
      ? `${cap(label)} ${of} ${show(good)}, mais ${o} ${of} ${show(bad)}.`
      : `${cap(label)} ${of} ${show(good)}, but ${o} ${of} ${show(bad)}.`,
    'mixed sentence: never a hard block',
  );
  // ambiguous
  add(
    'ambiguous',
    'ambiguous',
    fr ? `Pas de ${label} ${of} ${show(bad)}.` : `No ${label} ${of} ${show(bad)}.`,
    'negation',
  );
  add(
    'ambiguous',
    'ambiguous',
    fr
      ? `Le courrier cite « ${label} ${of} ${show(bad)} » en annexe.`
      : `The email quotes "${label} ${of} ${show(bad)}" in the annex.`,
    'quotation',
  );
  add(
    'ambiguous',
    'ambiguous',
    fr ? `${cap(label)} jusqu’à ${show(bad)}` : `${cap(label)} up to ${show(bad)}`,
    'ceiling',
  );
  if (spec.unit === 'percent') {
    add(
      'ambiguous',
      'ambiguous',
      fr ? `${cap(label)} de dix pour cent` : `${cap(label)} of ten percent`,
      'spelled-out',
    );
    add('ambiguous', 'ambiguous', `${cap(label)} : -${show(bad)}`, 'signed value');
  }
  // edge
  if (spec.unit === 'percent') {
    add(
      'edge',
      'violation',
      fr ? `${cap(label)} de ${bad},5 %` : `${cap(label)} of ${bad}.5%`,
      'decimal',
    );
    if (spec.op === 'lte' || spec.op === 'lt') {
      add(
        'edge',
        'violation',
        fr ? `${cap(label)} d’au moins ${show(bad)}` : `${cap(label)} of at least ${show(bad)}`,
        'floor above the cap',
      );
      add(
        'edge',
        'violation',
        fr
          ? `Merci d’appliquer ${label} à ${show(bad)} le 2026-10-18.`
          : `Please apply ${label} at ${show(bad)} on 2026-10-18.`,
        'ISO date nearby',
      );
    }
    add(
      'edge',
      'violation',
      `${cap(label)} ${of} ${bad * 100} bps`.replace('bps', fr ? 'points de base' : 'bps'),
      'basis points',
    );
  }
  if (spec.unit === 'amount') {
    add(
      'edge',
      'violation',
      `${cap(label)} ${of} ${SYMBOL[spec.cur ?? 'EUR']?.before(bad) ?? ''}`,
      'symbol before the amount',
    );
    add(
      'edge',
      'violation',
      fr
        ? `${cap(label)} : ${group(bad, ' ')} ${spec.cur === 'EUR' ? 'euros' : (spec.cur ?? '')}`
        : `${cap(label)}: ${group(bad, ',')} ${spec.cur === 'EUR' ? 'euros' : (spec.cur ?? '')}`,
      'narrow no-break space or comma grouping',
    );
    add(
      'edge',
      'ambiguous',
      `${cap(label)} ${of} ${bad} %`,
      'a percent where an amount is expected',
    );
  }
  if (spec.unit === 'count') {
    add(
      'edge',
      'violation',
      fr ? `Rapport du 2026-10-18 : ${bad} ${label}` : `Report of 2026-10-18: ${bad} ${label}`,
      'ISO date nearby',
    );
    add('edge', 'violation', `${cap(label)} = ${bad}`, 'equals sign');
  }
  return out;
}

// ------------------------------------------------------------- forbidden terms

interface Term {
  readonly dept: string;
  readonly lang: Lang;
  readonly id: string;
  readonly decision: 'forbid' | 'ask';
  readonly scopes: readonly ContentScope[];
  readonly terms: readonly string[];
  readonly except: readonly string[];
  readonly text: string;
  readonly alts: readonly string[];
}

const t = (
  dept: string,
  lang: Lang,
  id: string,
  terms: readonly string[],
  text: string,
  alts: readonly string[],
  extra: {
    except?: readonly string[];
    decision?: 'forbid' | 'ask';
    scopes?: readonly ContentScope[];
  } = {},
): Term => ({
  dept,
  lang,
  id,
  decision: extra.decision ?? 'forbid',
  scopes: extra.scopes ?? ALL,
  terms,
  except: extra.except ?? [],
  text,
  alts,
});

// prettier-ignore
export const TERMS: readonly Term[] = [
  t('marketing', 'fr', 'term-customer-acme', ['Acme'], 'Le client Acme n’est jamais nommé dans un document public.', ['Écrire « un grand distributeur »'], { except: ['usage interne'] },),
  t('marketing', 'en', 'term-competitor-globex', ['Globex'], 'Public material never names the competitor Globex.', ['Say "a competitor"'],),
  t('marketing', 'fr', 'term-guaranteed', ['garanti', 'garantie à vie'], 'Aucun support ne promet un résultat « garanti ».', ['Parler d’objectif', 'Citer la garantie légale'], { scopes: ALL },),
  t('marketing', 'en', 'term-guaranteed-en', ['guaranteed', 'risk-free'], 'Marketing copy never promises a guaranteed or risk-free outcome.', ['Describe typical results'],),
  t('marketing', 'fr', 'term-colour-black', ['noir', 'noire'], 'Le noir est banni de la campagne de printemps.', ['Utiliser le vert sauge', 'Utiliser le bleu nuit'], { scopes: FILE },),
  t('marketing', 'en', 'term-colour-neon', ['neon green', 'neon'], 'The neon green colour is not used in the new brand.', ['Use the brand teal'],),
  t('marketing', 'fr', 'term-slogan', ['Toujours plus loin'], 'L’ancien slogan « Toujours plus loin » ne doit plus apparaître.', ['Utiliser le nouveau slogan'],),
  t('marketing', 'en', 'term-best', ['world’s best', 'number one', 'best in the world'], 'No unsubstantiated superlatives such as "world’s best" in copy.', ['Quote a customer result'],),
  t('legal', 'fr', 'term-penal', ['clause pénale illimitée'], 'Aucun contrat ne contient de clause pénale illimitée.', ['Utiliser la clause plafonnée'],),
  t('legal', 'en', 'term-unlimited', ['unlimited liability', 'uncapped liability'], 'Contracts never accept unlimited liability.', ['Use the capped liability clause'],),
  t('legal', 'fr', 'term-exclusivite', ['exclusivité mondiale', 'exclusivité'], 'L’exclusivité n’est jamais promise sans accord du juridique.', ['Proposer une priorité commerciale'], { decision: 'ask' },),
  t('legal', 'en', 'term-code-name', ['Project Falcon'], 'The code name Project Falcon is confidential and never appears in outgoing documents.', ['Say "the programme"'], { except: ['internal only'] },),
  t('hr', 'fr', 'term-age', ['jeune dynamique', 'moins de 30 ans'], 'Les annonces ne mentionnent aucune condition d’âge.', ['Décrire les compétences recherchées'],),
  t('hr', 'en', 'term-gender', ['salesman', 'chairman', 'manpower'], 'Job ads use gender-neutral wording.', ['Use salesperson', 'Use chair'],),
  t('hr', 'fr', 'term-origin', ['de souche', 'type européen'], 'Aucune mention d’origine n’apparaît dans une annonce ou un message RH.', ['Décrire le poste uniquement'],),
  t('hr', 'en', 'term-salary-history', ['previous salary', 'salary history'], 'Never ask a candidate for their previous salary.', ['Ask for salary expectations'],),
  t('it', 'fr', 'term-secret', ['mot de passe en clair'], 'Aucun mot de passe en clair dans un document ou un message.', ['Utiliser le coffre de secrets'],),
  t('it', 'en', 'term-tech-forbidden', ['jQuery', 'Flash Player'], 'The technologies jQuery and Flash Player are forbidden in new projects.', ['Use the standard frontend framework'],),
  t('it', 'fr', 'term-vendor', ['Dropbox', 'WeTransfer'], 'Les services de partage Dropbox et WeTransfer sont interdits pour les données clients.', ['Utiliser l’espace de partage de l’entreprise'],),
  t('it', 'en', 'term-shadow-it', ['personal gmail', 'personal dropbox'], 'Work data never goes through personal Gmail or Dropbox accounts.', ['Use the company mailbox'],),
  t('eng', 'en', 'term-eval', ['eval(', 'document.write'], 'The constructs eval( and document.write are not allowed in code.', ['Use a parser'], { scopes: FILE },),
  t('eng', 'fr', 'term-todo', ['XXX', 'FIXME'], 'Les marqueurs XXX et FIXME ne sont pas livrés en production.', ['Ouvrir un ticket'], { scopes: FILE },),
  t('eng', 'en', 'term-license', ['GPL', 'AGPL'], 'GPL and AGPL dependencies are not allowed in the product.', ['Choose an MIT or Apache-2.0 library'],),
  t('eng', 'fr', 'term-lib', ['left-pad'], 'La bibliothèque left-pad ne doit pas être ajoutée.', [
    'Utiliser la fonction native',
  ]),
  t('support', 'fr', 'term-promise', ['sous 24 heures garanti', 'résolution immédiate'], 'Le support ne promet jamais une résolution immédiate.', ['Annoncer un délai indicatif'],),
  t('support', 'en', 'term-blame', ['your fault', 'you should have'], 'Replies never blame the customer.', ['Describe the next step'],),
  t('support', 'fr', 'term-pii', ['numéro de carte', 'code secret'], 'Ne jamais demander le numéro de carte ou le code secret du client.', ['Renvoyer vers le portail sécurisé'],),
  t('support', 'en', 'term-swear', ['stupid', 'idiot'], 'No insulting words in customer communication.', ['Stay neutral'],),
  t('compliance', 'en', 'term-bribe', ['facilitation payment', 'kickback'], 'The words facilitation payment and kickback never appear in an offer.', ['Contact compliance'],),
  t('compliance', 'fr', 'term-greenwash', ['neutre en carbone', '100 % écologique'], 'Les allégations « neutre en carbone » et « 100 % écologique » sont interdites sans label.', ['Citer le label et la méthode'],),
  t('compliance', 'en', 'term-sanctions', ['Iran', 'North Korea'], 'No quotation or contract is prepared for sanctioned countries.', ['Contact the export-control officer'], { decision: 'ask' },),
  t('compliance', 'fr', 'term-health-claim', ['guérit', 'soigne'], 'Aucun produit non médical n’affirme guérir ou soigner.', ['Parler de bien-être'],),
  t('finance', 'en', 'term-offshore', ['offshore account', 'shell company'], 'Payment instructions never mention an offshore account or a shell company.', ['Use the vendor master data'],),
  t('finance', 'fr', 'term-cash', ['paiement en espèces'], 'Aucun paiement en espèces n’est accepté ni proposé.', ['Virement bancaire'],),
  t('finance', 'en', 'term-insider', ['insider information', 'material non-public'], 'Insider information is never discussed in writing.', ['Contact legal'],),
  t('procurement', 'fr', 'term-supplier-blacklist', ['Fournitex', 'Bureau Express'], 'Les fournisseurs Fournitex et Bureau Express sont exclus des consultations.', ['Consulter la liste des fournisseurs agréés'],),
  t('procurement', 'en', 'term-single-source', ['sole source', 'single-source'], 'The wording sole source is not used without a justification file.', ['Attach the justification'], { decision: 'ask' },),
  t('ops', 'en', 'term-hazard', ['asbestos', 'mercury'], 'Documents never propose asbestos or mercury based materials.', ['Choose the certified alternative'],),
  t('ops', 'fr', 'term-subcontract', ['sous-traitance en cascade'], 'La sous-traitance en cascade n’est pas autorisée.', ['Limiter à un niveau'],),
  t('pr', 'fr', 'term-crisis', ['scandale', 'rappel produit'], 'Les messages publics n’emploient pas les mots scandale ou rappel produit sans validation de crise.', ['Contacter la cellule de crise'], { decision: 'ask' },),
  t('pr', 'en', 'term-leak', ['leaked', 'off the record'], 'Never describe information as leaked or off the record in outgoing messages.', ['Use "shared by the company"'],),
  t('pr', 'fr', 'term-politics', ['élection', 'parti politique'], 'Aucune prise de position sur une élection ou un parti politique.', ['Rester sur le produit'],),
  t('hse', 'en', 'term-unsafe', ['without protection', 'unprotected'], 'Procedures never allow work without protection.', ['Reference the PPE checklist'],),
  t('hse', 'fr', 'term-chimique', ['benzène', 'amiante'], 'Aucune procédure ne mentionne l’usage de benzène ou d’amiante.', ['Choisir un produit certifié'],),
  t('training', 'fr', 'term-plagiat', ['copier-coller', 'sujet corrigé'], 'Les supports de formation ne contiennent pas de « sujet corrigé » copié.', ['Rédiger un exemple original'],),
  t('training', 'en', 'term-exam', ['answer key', 'exam answers'], 'Training material never includes the exam answers.', ['Link to the practice set'],),
  t('realestate', 'fr', 'term-discrimination', ['pas de famille', 'sans enfants'], 'Une annonce immobilière ne cible aucun profil de locataire.', ['Décrire le bien seulement'],),
  t('realestate', 'en', 'term-steering', ['good neighbourhood', 'safe area'], 'Listings avoid subjective neighbourhood claims such as good neighbourhood.', ['Give distances and facts'],),
  t('health', 'fr', 'term-diagnostic', ['diagnostic', 'ordonnance'], 'Les courriers administratifs ne mentionnent ni diagnostic ni ordonnance.', ['Renvoyer vers le service médical'],),
  t('health', 'en', 'term-patient-name', ['patient record', 'medical record'], 'Administrative emails never mention a patient record.', ['Use the secure portal'],),
  t('rnd', 'en', 'term-patent', ['patent pending'], 'The phrase patent pending is only used once a filing exists.', ['Say "in development"'], { decision: 'ask' },),
  t('rnd', 'fr', 'term-secret-sauce', ['formule secrète'], 'Les documents externes ne parlent jamais de la formule secrète.', ['Parler de savoir-faire'],),
  t('partners', 'en', 'term-exclusive', ['exclusive partner', 'sole distributor'], 'No document calls anyone an exclusive partner or sole distributor.', ['Say "preferred partner"'],),
  t('partners', 'fr', 'term-garantie-revendeur', ['garantie constructeur étendue'], 'Les revendeurs ne promettent pas de garantie constructeur étendue.', ['Citer la garantie standard'],),
  t('data', 'en', 'term-personal-data', ['date of birth', 'social security number'], 'Exports never include date of birth or social security number.', ['Use an anonymous identifier'],),
  t('data', 'fr', 'term-donnees-sante', ['données de santé'], 'Les données de santé ne sont jamais copiées dans un outil d’IA.', ['Utiliser des données anonymisées'], { decision: 'ask' },),
  t('customer-success', 'en', 'term-churn-threat', ['cancel', 'switch to a competitor'], 'Replies never use the wording cancel or switch to a competitor first.', ['Ask what would help'], { except: ['cancel the meeting'] },),
  t('customer-success', 'fr', 'term-resiliation', ['résiliation facile', 'sans engagement'], 'Aucune offre n’est décrite comme « sans engagement » si un engagement existe.', ['Décrire la durée exacte'],),
  t('sales', 'fr', 'term-gratuit', ['gratuit', 'offert'], 'Le mot gratuit n’est pas utilisé pour un produit soumis à contrepartie.', ['Parler d’essai de 30 jours'],),
  t('sales', 'en', 'term-limited-time', ['limited time only', 'last chance'], 'No false urgency wording like "limited time only" or "last chance".', ['State the real end date'],),
  t('tenders', 'fr', 'term-confidentiel', ['confidentiel défense', 'secret défense'], 'Les réponses publiques ne reprennent aucune mention confidentiel défense.', ['Contacter le référent sécurité'],),
  t('tenders', 'en', 'term-conflict', ['former employee of the buyer', 'relative of the buyer'], 'Bids do not mention former employees or relatives of the buyer.', ['Declare the conflict to compliance'],),
];

function termSamples(spec: Term): Sample[] {
  const fr = spec.lang === 'fr';
  const first = spec.terms[0] ?? '';
  const out: Sample[] = [];
  const add = (category: Category, expect: Expect, text: string, note: string): void => {
    out.push({ text, expect, category, note });
  };
  const word = !/\s|\(|[^\p{L}\d]/u.test(first) && first.length >= 4;
  add(
    'violation',
    'violation',
    fr ? `Rédige un texte qui mentionne ${first}.` : `Write a text that mentions ${first}.`,
    'plain sentence',
  );
  add('violation', 'violation', `- ${first}`, 'list item');
  add('violation', 'violation', `{"note": "${first}"}`, 'JSON value');
  add('violation', 'violation', `| Sujet | ${first} |`, 'table cell');
  add(
    'violation',
    'violation',
    fr ? `Merci de parler de ${first.toUpperCase()}.` : `Please talk about ${first.toUpperCase()}.`,
    'upper case',
  );
  const second = spec.terms[1];
  if (second !== undefined)
    add(
      'violation',
      'violation',
      fr ? `Inclure aussi ${second} dans le message.` : `Also include ${second} in the message.`,
      'second term',
    );
  add(
    'compliant',
    'none',
    fr ? 'Rédige un texte neutre sur nos services.' : 'Write a neutral text about our services.',
    'no term',
  );
  add(
    'compliant',
    'none',
    fr ? 'Prépare la réunion du 2026-10-18 à 14 h.' : 'Prepare the meeting of 2026-10-18 at 2 pm.',
    'unrelated',
  );
  if (word) {
    add('other-subject', 'none', `${first.toLowerCase()}ology`, 'term inside a longer word');
    add(
      'other-subject',
      'none',
      `pre${first.toLowerCase()}ing`,
      'term inside a longer word, prefix',
    );
  } else {
    add(
      'other-subject',
      'none',
      fr ? 'Le sujet du jour est la planification.' : 'Today’s topic is planning.',
      'other subject',
    );
  }
  add(
    'ambiguous',
    'ambiguous',
    fr ? `Ne mentionne jamais ${first} dans le texte.` : `Never mention ${first} in the text.`,
    'negation',
  );
  add(
    'ambiguous',
    'ambiguous',
    fr
      ? `Le mot « ${first} » est interdit dans nos documents.`
      : `The word "${first}" is banned in our documents.`,
    'quotation',
  );
  const exception = spec.except[0];
  if (exception !== undefined)
    add('ambiguous', 'ambiguous', `${first} — ${exception}`, 'exception phrase');
  // accents folded: a person types without them
  const folded = first.normalize('NFD').replace(/\p{M}/gu, '');
  if (folded !== first)
    add(
      'edge',
      'violation',
      fr ? `Parle de ${folded} dans le texte.` : `Talk about ${folded} in the text.`,
      'typed without accents',
    );
  add(
    'edge',
    'violation',
    `${first}${/\s/u.test(first) || first.endsWith('(') ? '' : 's'}`.trim(),
    'plural form',
  );
  add(
    'edge',
    'violation',
    `« ${first} » est notre sujet.`.replace(/« | »/gu, ''),
    'at the start of the line',
  );
  return out;
}

export function corpus(): Case[] {
  const numeric = NUMERIC.map((spec): Case => ({
    dept: spec.dept,
    lang: spec.lang,
    rule: rule(spec),
    samples: numericSamples(spec),
  }));
  const terms = TERMS.map((spec): Case => ({
    dept: spec.dept,
    lang: spec.lang,
    rule: {
      id: spec.id,
      kind: 'content',
      decision: spec.decision,
      reason: spec.text,
      required: true,
      topic: spec.dept,
      text: spec.text,
      subject_aliases: [],
      scopes: spec.scopes,
      constraint: { kind: 'forbidden_terms', terms: spec.terms, context_exceptions: spec.except },
      alternatives: spec.alts,
    },
    samples: termSamples(spec),
  }));
  return [...numeric, ...terms];
}

/**
 * Hand-written, messier texts: what people really type. Each one is attached to a rule of the
 * corpus above by id, with the verdict a careful reader would give.
 */
// prettier-ignore
export const REALISTIC: readonly (readonly [
  id: string,
  text: string,
  expect: Expect,
  note: string,
])[] = [
  // discounts in business prose
  ['sales-discount-cap', 'Pour le lot A on peut aller à 5 % de remise, mais pour le lot B le client demande 12 % de remise.', 'violation', 'two lots, the second breaks the cap',],
  ['sales-discount-cap', 'Remise 5 % + 3 % de remise volume, soit 8 % cumulés.', 'violation', 'cumulated, the second part breaks nothing alone but the total is stated',],
  ['sales-discount-cap', 'Le client a obtenu une remise exceptionnelle de 15 % sur la seconde pièce.', 'violation', 'long sentence, qualifier before the subject',],
  ['sales-discount-cap', 'Remise : de 5 à 10 %', 'ambiguous', 'a range crossing the cap'],
  ['sales-discount-cap', 'Nous espérons une hausse de 10 % du panier moyen grâce à la remise de 3 %.', 'none', 'other subject first, compliant discount after',],
  ['sales-discount-cap', 'Offre valable du 12/10/2026 au 15/10/2026, remise de 4 %.', 'none', 'dates and a compliant value',],
  ['sales-discount-cap', 'Taux de TVA 20 %. Remise commerciale de 6 % sur le total HT.', 'violation', 'VAT then a breaking discount',],
  ['sales-discount-cap', 'Merci d’indiquer la remise (max 5 %) dans le champ prévu.', 'none', 'the cap itself, quoted as instruction',],
  ['sales-discount-cap', 'Remise x2 sur les accessoires', 'none', 'no stated percentage'],
  ['sales-discount-cap', 'La remise passerait de 3 % à 9 % après validation.', 'ambiguous', 'from-to, the end value breaks the cap',],
  ['sales-discount-cap', 'discount_pct: 11', 'none', 'bare number under a key the rule does not read as percent',],
  ['sales-discount-cap-en', 'We could stretch the discount to 7.5% if they sign this quarter.', 'ambiguous', 'a conditional offer is supposed, not stated: the AI decides',],
  ['sales-discount-cap-en', 'Gross margin is 31%, discount offered 4%, payment 30 days.', 'none', 'several figures, all fine',],
  ['sales-discount-cap-en', 'Customer asked for a 20% off coupon.', 'ambiguous', 'off-coupon wording, no alias nearby',],
  ['sales-discount-cap-en', 'Revenue is up 12% year on year and the discount rate stays at 2%.', 'none', 'another subject then a compliant one',],
  ['sales-discount-cap-en', 'We give them 10 percent off the list price.', 'ambiguous', 'percent off, no alias',],
  // amounts
  ['sales-deal-approval', 'Montant du contrat : 120 000 €', 'violation', 'plain amount above the ceiling',],
  ['sales-deal-approval', 'Le contrat est estimé à 1,2 M€', 'violation', 'abbreviated millions'],
  ['sales-deal-approval', 'Montant du contrat : 85 k€', 'none', 'abbreviated thousands below the ceiling',],
  ['sales-deal-approval', 'Contrat de 150k €', 'violation', 'abbreviated thousands above the ceiling',],
  ['sales-deal-approval', 'Montant du contrat 99 999,99 €', 'none', 'decimal cents below'],
  ['sales-deal-approval', 'Montant du contrat : 100 000,01 €', 'violation', 'just above'],
  ['sales-deal-approval', 'Le chiffre d’affaires client est de 5 000 000 €', 'none', 'another subject, large amount',],
  ['fin-meal-expense', 'Meal expense: $55.50 for the team lunch', 'violation', 'US decimal cents'],
  ['fin-meal-expense', 'Meal expense $38 plus $12 tip', 'none', 'two amounts, only the first is the subject',],
  ['fin-meal-expense', 'The dinner cost 2,500 USD for 50 people', 'none', 'another subject (dinner), per-person not stated',],
  // counts
  ['tender-page-limit', 'Le mémoire fait 45 pages, annexes comprises.', 'violation', 'count then noun in a sentence',],
  ['tender-page-limit', 'Mémoire technique (24 pages) et annexes (80 pages)', 'violation', 'two counts, one breaks',],
  ['tender-page-limit', 'Page 45 sur 120 du rapport', 'none', 'page numbering is not a page count'],
  ['tender-page-limit', 'Voir les pages 12 à 40', 'ambiguous', 'a reference range: code cannot tell it from a length',],
  ['tender-word-limit', 'The summary is 2,500 words long.', 'violation', 'English thousands'],
  ['tender-word-limit', 'The summary is 1.500 words long.', 'none', 'grouping with a dot'],
  ['sales-payment-terms', 'Payment terms: net 90 days', 'violation', 'net 90'],
  ['sales-payment-terms', 'Payment terms of 45 days end of month', 'none', 'compliant'],
  ['sales-payment-terms', 'The warranty runs 90 days', 'none', 'another subject, same number'],
  // marketing / brand
  ['mkt-promo-cap', 'Jusqu’à -40 % sur toute la collection !', 'ambiguous', 'classic retail ceiling, no alias',],
  ['mkt-promo-cap', 'Promo de 50 % ce week-end', 'violation', 'plain'],
  ['mkt-promo-cap', 'Promotion : 25 % sur les chaussures', 'none', 'compliant'],
  // terms in context
  ['term-customer-acme', 'Voici le brouillon du communiqué : "Acme choisit notre solution"', 'violation', 'a quoted headline names the customer',],
  ['term-customer-acme', 'Client: Acme (usage interne)', 'ambiguous', 'internal use exception'],
  ['term-customer-acme', 'Rappel : nous n’avons pas de contrat avec Acme.', 'ambiguous', 'negated statement',],
  ['term-customer-acme', 'Acme. Acme! Acme?', 'violation', 'the bare name'],
  ['term-customer-acme', 'On parle du pacme, du macmenu et de l’acmé.', 'none', 'inside other words',],
  ['term-guaranteed-en', 'Results are not guaranteed.', 'ambiguous', 'negated promise'],
  ['term-guaranteed-en', 'Guaranteed results in 30 days or your money back', 'violation', 'the promise itself',],
  ['term-guaranteed-en', 'This product is risk-free.', 'violation', 'second term'],
  ['term-colour-black', 'Utiliser un fond noir et du texte blanc', 'violation', 'colour in a design brief',],
  ['term-colour-black', 'Le marché noir de la billetterie', 'violation', 'the word, in another sense (a limit the matcher cannot judge)',],
  ['term-colour-black', 'Noir, c’est noir. Noire est la nuit.', 'violation', 'case and feminine'],
  ['term-colour-black', 'Chez Noiraud et Noirmoutier', 'none', 'names that contain the word'],
  ['term-tech-forbidden', 'import $ from "jquery"; // uses jQuery 3', 'violation', 'code line'],
  ['term-tech-forbidden', 'We migrated away from jQuery last year.', 'violation', 'mention in prose (the product does not judge intent)',],
  ['term-vendor', 'Envoie le fichier via WeTransfer stp', 'violation', 'casual request'],
  ['term-vendor', 'On utilise l’espace de partage interne, pas de dropbox', 'ambiguous', 'negation about the vendor',],
  ['term-eval', 'const x = eval(input)', 'violation', 'code'],
  ['term-eval', 'medieval(2)', 'none', 'inside another word'],
  ['term-todo', '// FIXME: remove before release', 'violation', 'marker in a comment'],
  ['term-todo', 'Le prix est de XXXL euros', 'none', 'XXX inside a longer token'],
  ['term-age', 'Nous cherchons un jeune dynamique pour rejoindre l’équipe.', 'violation', 'the phrase',],
  ['term-gender', 'We are hiring a salesman and a chairman.', 'violation', 'two terms'],
  ['term-gender', 'Salesmen wanted', 'violation', 'plural'],
  ['term-pii', 'Peux-tu me donner ton numéro de carte ?', 'violation', 'asking for card number'],
  ['term-pii', 'Ne communiquez jamais votre numéro de carte.', 'ambiguous', 'warning not to'],
  ['term-sanctions', 'Prepare a quotation for a customer in Iran', 'violation', 'ask rule term'],
  ['term-sanctions', 'Quotation for Irani Textiles Ltd', 'none', 'a longer word'],
];
