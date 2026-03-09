/**
 * Seed law_sources entries for each of the 50 states + DC, pointing to their
 * constitutions, statutes/codes, and administrative codes.
 *
 * All data is static.  Each record is matched to its jurisdiction_id via a
 * slug lookup at runtime.  Upserts use source_url as the conflict key so the
 * script is safe to re-run.
 *
 * Run with:  npm run import:state-laws
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LawType =
  | 'constitution'
  | 'statute'
  | 'regulation'
  | 'executive_order'
  | 'ordinance'
  | 'administrative_code'
  | 'municipal_code';

interface StateLawEntry {
  law_type: LawType;
  title: string;
  source_url: string;
  description: string;
  api_url?: string;
}

interface StateLawSourceDefinition {
  /** Two-letter postal abbreviation — used only for logging. */
  abbr: string;
  /** Must match jurisdictions.slug in the database. */
  jurisdictionSlug: string;
  entries: StateLawEntry[];
}

interface LawSourceInsert {
  jurisdiction_id: string;
  law_type: LawType;
  title: string;
  source_url: string;
  description: string;
  api_url: string | null;
}

// ---------------------------------------------------------------------------
// Static data — 50 states + DC
// ---------------------------------------------------------------------------

const STATE_LAW_SOURCES: StateLawSourceDefinition[] = [
  {
    abbr: 'AL', jurisdictionSlug: 'alabama',
    entries: [
      { law_type: 'constitution', title: 'Alabama Constitution', source_url: 'https://constitutions.alabama.gov/', description: 'The Constitution of the State of Alabama.' },
      { law_type: 'statute', title: 'Code of Alabama', source_url: 'https://law.justia.com/codes/alabama/', description: 'Official codification of Alabama statutory law.' },
      { law_type: 'administrative_code', title: 'Alabama Administrative Code', source_url: 'https://www.alabamaadministrativecode.state.al.us/', description: 'Codified rules and regulations of Alabama state agencies.' },
    ],
  },
  {
    abbr: 'AK', jurisdictionSlug: 'alaska',
    entries: [
      { law_type: 'constitution', title: 'Alaska Constitution', source_url: 'https://ltgov.alaska.gov/information/alaskas-constitution/', description: 'The Constitution of the State of Alaska.' },
      { law_type: 'statute', title: 'Alaska Statutes', source_url: 'https://www.akleg.gov/basis/statutes.asp', description: 'Official Alaska Statutes maintained by the Alaska Legislature.' },
      { law_type: 'administrative_code', title: 'Alaska Administrative Code', source_url: 'https://www.akleg.gov/basis/aac.asp', description: 'Official Alaska Administrative Code.' },
    ],
  },
  {
    abbr: 'AZ', jurisdictionSlug: 'arizona',
    entries: [
      { law_type: 'constitution', title: 'Arizona Constitution', source_url: 'https://www.azleg.gov/constitution/', description: 'The Constitution of the State of Arizona.' },
      { law_type: 'statute', title: 'Arizona Revised Statutes', source_url: 'https://www.azleg.gov/arstitle/', description: 'Official Arizona Revised Statutes.' },
      { law_type: 'administrative_code', title: 'Arizona Administrative Code', source_url: 'https://apps.azsos.gov/public_services/Title_09/9-01.pdf', description: 'Arizona Administrative Code published by the Secretary of State.' },
    ],
  },
  {
    abbr: 'AR', jurisdictionSlug: 'arkansas',
    entries: [
      { law_type: 'constitution', title: 'Arkansas Constitution', source_url: 'https://www.arkleg.state.ar.us/Assembly/Information/Pages/ArkansasConstitution.aspx', description: 'The Constitution of the State of Arkansas.' },
      { law_type: 'statute', title: 'Arkansas Code Annotated', source_url: 'https://www.arkleg.state.ar.us/Laws/Statutes', description: 'Official Arkansas Code Annotated.' },
      { law_type: 'administrative_code', title: 'Arkansas Administrative Rules', source_url: 'https://www.sos.arkansas.gov/rules-and-regulations/', description: 'Arkansas state agency rules and regulations.' },
    ],
  },
  {
    abbr: 'CA', jurisdictionSlug: 'california',
    entries: [
      { law_type: 'constitution', title: 'California Constitution', source_url: 'https://leginfo.legislature.ca.gov/faces/codes_displayexpandedbranch.xhtml?tocCode=CONS&division=&title=&part=&chapter=&article=', description: 'The Constitution of the State of California.' },
      { law_type: 'statute', title: 'California Codes', source_url: 'https://leginfo.legislature.ca.gov/faces/codes.xhtml', description: 'Official California Codes (statutory law) maintained by the Legislature.' },
      { law_type: 'administrative_code', title: 'California Code of Regulations', source_url: 'https://govt.westlaw.com/calregs/', description: 'Official California Code of Regulations (CCR).' },
    ],
  },
  {
    abbr: 'CO', jurisdictionSlug: 'colorado',
    entries: [
      { law_type: 'constitution', title: 'Colorado Constitution', source_url: 'https://leg.colorado.gov/colorado-constitution', description: 'The Constitution of the State of Colorado.' },
      { law_type: 'statute', title: 'Colorado Revised Statutes', source_url: 'https://leg.colorado.gov/colorado-revised-statutes', description: 'Official Colorado Revised Statutes.' },
      { law_type: 'administrative_code', title: 'Code of Colorado Regulations', source_url: 'https://www.sos.state.co.us/CCR/Welcome.do', description: 'Code of Colorado Regulations maintained by the Secretary of State.' },
    ],
  },
  {
    abbr: 'CT', jurisdictionSlug: 'connecticut',
    entries: [
      { law_type: 'constitution', title: 'Connecticut Constitution', source_url: 'https://www.cga.ct.gov/asp/Content/constitutions/CTConstitution.htm', description: 'The Constitution of the State of Connecticut.' },
      { law_type: 'statute', title: 'Connecticut General Statutes', source_url: 'https://www.cga.ct.gov/current/pub/titles.htm', description: 'Official Connecticut General Statutes.' },
      { law_type: 'administrative_code', title: 'Regulations of Connecticut State Agencies', source_url: 'https://eregulations.ct.gov/eRegsPortal/', description: 'Connecticut state agency regulations.' },
    ],
  },
  {
    abbr: 'DE', jurisdictionSlug: 'delaware',
    entries: [
      { law_type: 'constitution', title: 'Delaware Constitution', source_url: 'https://legis.delaware.gov/Constitution', description: 'The Constitution of the State of Delaware.' },
      { law_type: 'statute', title: 'Delaware Code', source_url: 'https://delcode.delaware.gov/', description: 'Official Delaware Code.' },
      { law_type: 'administrative_code', title: 'Delaware Administrative Code', source_url: 'https://regulations.delaware.gov/', description: 'Delaware Administrative Code maintained by the Division of Research.' },
    ],
  },
  {
    abbr: 'FL', jurisdictionSlug: 'florida',
    entries: [
      { law_type: 'constitution', title: 'Florida Constitution', source_url: 'https://www.flsenate.gov/Laws/Constitution', description: 'The Constitution of the State of Florida.' },
      { law_type: 'statute', title: 'Florida Statutes', source_url: 'https://www.flsenate.gov/Laws/Statutes', description: 'Official Florida Statutes.' },
      { law_type: 'administrative_code', title: 'Florida Administrative Code & Register', source_url: 'https://www.flrules.org/', description: 'Florida Administrative Code and Florida Administrative Register.' },
    ],
  },
  {
    abbr: 'GA', jurisdictionSlug: 'georgia',
    entries: [
      { law_type: 'constitution', title: 'Georgia Constitution', source_url: 'https://www.legis.ga.gov/Joint/clec/Documents/GaConstitutionCurrent.pdf', description: 'The Constitution of the State of Georgia.' },
      { law_type: 'statute', title: 'Official Code of Georgia Annotated', source_url: 'https://www.lexisnexis.com/hottopics/gacode/', description: 'Official Code of Georgia Annotated (OCGA).' },
      { law_type: 'administrative_code', title: 'Georgia Compilation of Rules and Regulations', source_url: 'https://rules.sos.ga.gov/', description: 'Georgia administrative rules and regulations.' },
    ],
  },
  {
    abbr: 'HI', jurisdictionSlug: 'hawaii',
    entries: [
      { law_type: 'constitution', title: 'Hawaii Constitution', source_url: 'https://www.capitol.hawaii.gov/constitution/constitution.aspx', description: 'The Constitution of the State of Hawaii.' },
      { law_type: 'statute', title: 'Hawaii Revised Statutes', source_url: 'https://www.capitol.hawaii.gov/docs/hrs.htm', description: 'Official Hawaii Revised Statutes.' },
      { law_type: 'administrative_code', title: 'Hawaii Administrative Rules', source_url: 'https://ags.hawaii.gov/har/', description: 'Hawaii Administrative Rules.' },
    ],
  },
  {
    abbr: 'ID', jurisdictionSlug: 'idaho',
    entries: [
      { law_type: 'constitution', title: 'Idaho Constitution', source_url: 'https://legislature.idaho.gov/statutesrules/idconst/', description: 'The Constitution of the State of Idaho.' },
      { law_type: 'statute', title: 'Idaho Statutes', source_url: 'https://legislature.idaho.gov/statutesrules/idstat/', description: 'Official Idaho Statutes.' },
      { law_type: 'administrative_code', title: 'Idaho Administrative Code', source_url: 'https://adminrules.idaho.gov/', description: 'Idaho Administrative Code and Administrative Bulletin.' },
    ],
  },
  {
    abbr: 'IL', jurisdictionSlug: 'illinois',
    entries: [
      { law_type: 'constitution', title: 'Illinois Constitution', source_url: 'https://www.ilga.gov/commission/lrb/con.htm', description: 'The Constitution of the State of Illinois.' },
      { law_type: 'statute', title: 'Illinois Compiled Statutes', source_url: 'https://www.ilga.gov/legislation/ilcs/ilcs.asp', description: 'Official Illinois Compiled Statutes (ILCS).' },
      { law_type: 'administrative_code', title: 'Illinois Administrative Code', source_url: 'https://www.ilga.gov/commission/jcar/admincode/titles.html', description: 'Illinois Administrative Code.' },
    ],
  },
  {
    abbr: 'IN', jurisdictionSlug: 'indiana',
    entries: [
      { law_type: 'constitution', title: 'Indiana Constitution', source_url: 'https://iga.in.gov/legislative/laws/const/', description: 'The Constitution of the State of Indiana.' },
      { law_type: 'statute', title: 'Indiana Code', source_url: 'https://iga.in.gov/legislative/laws/2024/ic/titles/', description: 'Official Indiana Code.' },
      { law_type: 'administrative_code', title: 'Indiana Administrative Code', source_url: 'https://iac.iga.in.gov/', description: 'Indiana Administrative Code.' },
    ],
  },
  {
    abbr: 'IA', jurisdictionSlug: 'iowa',
    entries: [
      { law_type: 'constitution', title: 'Iowa Constitution', source_url: 'https://www.legis.iowa.gov/law/iowaCode/constitution', description: 'The Constitution of the State of Iowa.' },
      { law_type: 'statute', title: 'Iowa Code', source_url: 'https://www.legis.iowa.gov/law/iowaCode/sections', description: 'Official Iowa Code.' },
      { law_type: 'administrative_code', title: 'Iowa Administrative Code', source_url: 'https://www.legis.iowa.gov/law/administrativeRules/agencies', description: 'Iowa Administrative Code.' },
    ],
  },
  {
    abbr: 'KS', jurisdictionSlug: 'kansas',
    entries: [
      { law_type: 'constitution', title: 'Kansas Constitution', source_url: 'https://www.kslegislature.org/li/constitution/', description: 'The Constitution of the State of Kansas.' },
      { law_type: 'statute', title: 'Kansas Statutes Annotated', source_url: 'https://www.kslegislature.org/li/b2023_24/statute/', description: 'Official Kansas Statutes Annotated (KSA).' },
      { law_type: 'administrative_code', title: 'Kansas Administrative Regulations', source_url: 'https://www.sos.ks.gov/services/pub_adminregulations.aspx', description: 'Kansas Administrative Regulations.' },
    ],
  },
  {
    abbr: 'KY', jurisdictionSlug: 'kentucky',
    entries: [
      { law_type: 'constitution', title: 'Kentucky Constitution', source_url: 'https://apps.legislature.ky.gov/law/constitution/default.aspx', description: 'The Constitution of the Commonwealth of Kentucky.' },
      { law_type: 'statute', title: 'Kentucky Revised Statutes', source_url: 'https://apps.legislature.ky.gov/law/statutes/', description: 'Official Kentucky Revised Statutes (KRS).' },
      { law_type: 'administrative_code', title: 'Kentucky Administrative Regulations', source_url: 'https://apps.legislature.ky.gov/law/kar/', description: 'Kentucky Administrative Regulations (KAR).' },
    ],
  },
  {
    abbr: 'LA', jurisdictionSlug: 'louisiana',
    entries: [
      { law_type: 'constitution', title: 'Louisiana Constitution', source_url: 'https://www.legis.la.gov/legis/LawSearch.aspx', description: 'The Constitution of the State of Louisiana.' },
      { law_type: 'statute', title: 'Louisiana Revised Statutes', source_url: 'https://www.legis.la.gov/legis/LawSearch.aspx', description: 'Official Louisiana Revised Statutes.' },
      { law_type: 'administrative_code', title: 'Louisiana Administrative Code', source_url: 'https://www.doa.la.gov/doa/ors/law-resources/louisiana-administrative-code/', description: 'Louisiana Administrative Code.' },
    ],
  },
  {
    abbr: 'ME', jurisdictionSlug: 'maine',
    entries: [
      { law_type: 'constitution', title: 'Maine Constitution', source_url: 'https://legislature.maine.gov/ros/LOM/LOM121st/pub/Constitution/const.htm', description: 'The Constitution of the State of Maine.' },
      { law_type: 'statute', title: 'Maine Revised Statutes', source_url: 'https://legislature.maine.gov/statutes/', description: 'Official Maine Revised Statutes.' },
      { law_type: 'administrative_code', title: 'Code of Maine Rules', source_url: 'https://www.maine.gov/sos/cec/rules/', description: 'Code of Maine Rules.' },
    ],
  },
  {
    abbr: 'MD', jurisdictionSlug: 'maryland',
    entries: [
      { law_type: 'constitution', title: 'Maryland Constitution', source_url: 'https://msa.maryland.gov/msa/mdmanual/43const/html/const.html', description: 'The Constitution of the State of Maryland.' },
      { law_type: 'statute', title: 'Annotated Code of Maryland', source_url: 'https://mgaleg.maryland.gov/mgawebsite/Laws/StatuteText', description: 'Official Annotated Code of Maryland.' },
      { law_type: 'administrative_code', title: 'Code of Maryland Regulations', source_url: 'https://www.dsd.state.md.us/', description: 'Code of Maryland Regulations (COMAR).' },
    ],
  },
  {
    abbr: 'MA', jurisdictionSlug: 'massachusetts',
    entries: [
      { law_type: 'constitution', title: 'Massachusetts Constitution', source_url: 'https://malegislature.gov/Laws/Constitution', description: 'The Constitution of the Commonwealth of Massachusetts.' },
      { law_type: 'statute', title: 'Massachusetts General Laws', source_url: 'https://malegislature.gov/Laws/GeneralLaws', description: 'Official Massachusetts General Laws.' },
      { law_type: 'administrative_code', title: 'Code of Massachusetts Regulations', source_url: 'https://www.mass.gov/code-of-massachusetts-regulations-cmr', description: 'Code of Massachusetts Regulations (CMR).' },
    ],
  },
  {
    abbr: 'MI', jurisdictionSlug: 'michigan',
    entries: [
      { law_type: 'constitution', title: 'Michigan Constitution', source_url: 'https://www.legislature.mi.gov/(S(wd2grjb2pbycfyzowlhjpgqe))/mileg.aspx?page=MCLBasicSearch', description: 'The Constitution of the State of Michigan.' },
      { law_type: 'statute', title: 'Michigan Compiled Laws', source_url: 'https://www.legislature.mi.gov/documents/mcl/pdf/mcl-index.pdf', description: 'Official Michigan Compiled Laws (MCL).' },
      { law_type: 'administrative_code', title: 'Michigan Administrative Code', source_url: 'https://ars.apps.lara.state.mi.us/AdminCode/DownloadAdminCode', description: 'Michigan Administrative Code.' },
    ],
  },
  {
    abbr: 'MN', jurisdictionSlug: 'minnesota',
    entries: [
      { law_type: 'constitution', title: 'Minnesota Constitution', source_url: 'https://www.revisor.mn.gov/constitution/', description: 'The Constitution of the State of Minnesota.' },
      { law_type: 'statute', title: 'Minnesota Statutes', source_url: 'https://www.revisor.mn.gov/statutes/', description: 'Official Minnesota Statutes.' },
      { law_type: 'administrative_code', title: 'Minnesota Rules', source_url: 'https://www.revisor.mn.gov/rules/', description: 'Minnesota Administrative Rules.' },
    ],
  },
  {
    abbr: 'MS', jurisdictionSlug: 'mississippi',
    entries: [
      { law_type: 'constitution', title: 'Mississippi Constitution', source_url: 'https://www.sos.ms.gov/content/documents/elections/Mississippi_Constitution.pdf', description: 'The Constitution of the State of Mississippi.' },
      { law_type: 'statute', title: 'Mississippi Code Annotated', source_url: 'https://law.justia.com/codes/mississippi/', description: 'Official Mississippi Code Annotated.' },
      { law_type: 'administrative_code', title: 'Mississippi Administrative Code', source_url: 'https://www.sos.ms.gov/adminsearch/Default.aspx', description: 'Mississippi Administrative Code.' },
    ],
  },
  {
    abbr: 'MO', jurisdictionSlug: 'missouri',
    entries: [
      { law_type: 'constitution', title: 'Missouri Constitution', source_url: 'https://www.moga.mo.gov/mostatutes/moconst.html', description: 'The Constitution of the State of Missouri.' },
      { law_type: 'statute', title: 'Missouri Revised Statutes', source_url: 'https://www.moga.mo.gov/mostatutes/stathtml/statchap.html', description: 'Official Missouri Revised Statutes (RSMo).' },
      { law_type: 'administrative_code', title: 'Code of State Regulations (Missouri)', source_url: 'https://www.sos.mo.gov/adrules/csr/csr.htm', description: 'Missouri Code of State Regulations.' },
    ],
  },
  {
    abbr: 'MT', jurisdictionSlug: 'montana',
    entries: [
      { law_type: 'constitution', title: 'Montana Constitution', source_url: 'https://leg.mt.gov/bills/mca_toc/CONSTITUTION.htm', description: 'The Constitution of the State of Montana.' },
      { law_type: 'statute', title: 'Montana Code Annotated', source_url: 'https://leg.mt.gov/bills/mca_toc/', description: 'Official Montana Code Annotated (MCA).' },
      { law_type: 'administrative_code', title: 'Administrative Rules of Montana', source_url: 'https://www.mtrules.org/', description: 'Administrative Rules of Montana (ARM).' },
    ],
  },
  {
    abbr: 'NE', jurisdictionSlug: 'nebraska',
    entries: [
      { law_type: 'constitution', title: 'Nebraska Constitution', source_url: 'https://nebraskalegislature.gov/laws/articles.php', description: 'The Constitution of the State of Nebraska.' },
      { law_type: 'statute', title: 'Nebraska Revised Statutes', source_url: 'https://nebraskalegislature.gov/laws/statutes.php', description: 'Official Nebraska Revised Statutes.' },
      { law_type: 'administrative_code', title: 'Nebraska Administrative Code', source_url: 'https://www.sos.ne.gov/rules-and-regs/regsearch/index.shtml', description: 'Nebraska Administrative Code.' },
    ],
  },
  {
    abbr: 'NV', jurisdictionSlug: 'nevada',
    entries: [
      { law_type: 'constitution', title: 'Nevada Constitution', source_url: 'https://www.leg.state.nv.us/Division/Legal/LawLibrary/NRS/NevadaConstitution.html', description: 'The Constitution of the State of Nevada.' },
      { law_type: 'statute', title: 'Nevada Revised Statutes', source_url: 'https://www.leg.state.nv.us/NRS/', description: 'Official Nevada Revised Statutes (NRS).' },
      { law_type: 'administrative_code', title: 'Nevada Administrative Code', source_url: 'https://www.leg.state.nv.us/NAC/', description: 'Nevada Administrative Code (NAC).' },
    ],
  },
  {
    abbr: 'NH', jurisdictionSlug: 'new-hampshire',
    entries: [
      { law_type: 'constitution', title: 'New Hampshire Constitution', source_url: 'https://www.nh.gov/glance/constitution.htm', description: 'The Constitution of the State of New Hampshire.' },
      { law_type: 'statute', title: 'New Hampshire Revised Statutes Annotated', source_url: 'https://www.gencourt.state.nh.us/rsa/html/', description: 'Official New Hampshire Revised Statutes Annotated (RSA).' },
      { law_type: 'administrative_code', title: 'New Hampshire Administrative Rules', source_url: 'https://www.gencourt.state.nh.us/rules/', description: 'New Hampshire Code of Administrative Rules.' },
    ],
  },
  {
    abbr: 'NJ', jurisdictionSlug: 'new-jersey',
    entries: [
      { law_type: 'constitution', title: 'New Jersey Constitution', source_url: 'https://www.njleg.state.nj.us/lawsconstitution/constitution.asp', description: 'The Constitution of the State of New Jersey.' },
      { law_type: 'statute', title: 'New Jersey Statutes Annotated', source_url: 'https://www.njleg.state.nj.us/lawsconstitution/statutes.asp', description: 'Official New Jersey Statutes Annotated (NJSA).' },
      { law_type: 'administrative_code', title: 'New Jersey Administrative Code', source_url: 'https://www.state.nj.us/infobank/njcode.htm', description: 'New Jersey Administrative Code (NJAC).' },
    ],
  },
  {
    abbr: 'NM', jurisdictionSlug: 'new-mexico',
    entries: [
      { law_type: 'constitution', title: 'New Mexico Constitution', source_url: 'https://www.nmlegis.gov/Publications/New_Mexico_Constitution.pdf', description: 'The Constitution of the State of New Mexico.' },
      { law_type: 'statute', title: 'New Mexico Statutes Annotated', source_url: 'https://www.nmlegis.gov/Legislation/Statute_Rules_Index', description: 'Official New Mexico Statutes Annotated (NMSA).' },
      { law_type: 'administrative_code', title: 'New Mexico Administrative Code', source_url: 'https://www.srca.nm.gov/nmac/', description: 'New Mexico Administrative Code (NMAC).' },
    ],
  },
  {
    abbr: 'NY', jurisdictionSlug: 'new-york',
    entries: [
      { law_type: 'constitution', title: 'New York State Constitution', source_url: 'https://www.nysenate.gov/legislation/laws/CNS', description: 'The Constitution of the State of New York.' },
      { law_type: 'statute', title: 'New York Consolidated Laws', source_url: 'https://www.nysenate.gov/legislation/laws/CONSOLIDATED', description: 'Official New York Consolidated Laws.' },
      { law_type: 'administrative_code', title: 'New York Codes, Rules and Regulations', source_url: 'https://govt.westlaw.com/nycrr/', description: 'New York Codes, Rules and Regulations (NYCRR).' },
    ],
  },
  {
    abbr: 'NC', jurisdictionSlug: 'north-carolina',
    entries: [
      { law_type: 'constitution', title: 'North Carolina Constitution', source_url: 'https://www.ncleg.gov/Laws/Constitution', description: 'The Constitution of the State of North Carolina.' },
      { law_type: 'statute', title: 'North Carolina General Statutes', source_url: 'https://www.ncleg.gov/Laws/GeneralStatutesTOC', description: 'Official North Carolina General Statutes (NCGS).' },
      { law_type: 'administrative_code', title: 'North Carolina Administrative Code', source_url: 'https://www.oah.nc.gov/rules/north-carolina-administrative-code/', description: 'North Carolina Administrative Code (NCAC).' },
    ],
  },
  {
    abbr: 'ND', jurisdictionSlug: 'north-dakota',
    entries: [
      { law_type: 'constitution', title: 'North Dakota Constitution', source_url: 'https://www.legis.nd.gov/constitution/', description: 'The Constitution of the State of North Dakota.' },
      { law_type: 'statute', title: 'North Dakota Century Code', source_url: 'https://www.legis.nd.gov/general-information/north-dakota-century-code', description: 'Official North Dakota Century Code (NDCC).' },
      { law_type: 'administrative_code', title: 'North Dakota Administrative Code', source_url: 'https://www.legis.nd.gov/agency-rules/north-dakota-administrative-code', description: 'North Dakota Administrative Code.' },
    ],
  },
  {
    abbr: 'OH', jurisdictionSlug: 'ohio',
    entries: [
      { law_type: 'constitution', title: 'Ohio Constitution', source_url: 'https://codes.ohio.gov/ohio-constitution', description: 'The Constitution of the State of Ohio.' },
      { law_type: 'statute', title: 'Ohio Revised Code', source_url: 'https://codes.ohio.gov/ohio-revised-code', description: 'Official Ohio Revised Code (ORC).' },
      { law_type: 'administrative_code', title: 'Ohio Administrative Code', source_url: 'https://codes.ohio.gov/ohio-administrative-code', description: 'Ohio Administrative Code (OAC).' },
    ],
  },
  {
    abbr: 'OK', jurisdictionSlug: 'oklahoma',
    entries: [
      { law_type: 'constitution', title: 'Oklahoma Constitution', source_url: 'https://www.oscn.net/applications/oscn/index.asp?level=1&ftdb=STOKCONST', description: 'The Constitution of the State of Oklahoma.' },
      { law_type: 'statute', title: 'Oklahoma Statutes', source_url: 'https://www.oscn.net/applications/oscn/index.asp?level=1&ftdb=STOKST', description: 'Official Oklahoma Statutes.' },
      { law_type: 'administrative_code', title: 'Oklahoma Administrative Code', source_url: 'https://www.sos.ok.gov/oar/online/goToOAC.aspx', description: 'Oklahoma Administrative Code.' },
    ],
  },
  {
    abbr: 'OR', jurisdictionSlug: 'oregon',
    entries: [
      { law_type: 'constitution', title: 'Oregon Constitution', source_url: 'https://www.oregonlegislature.gov/bills_laws/Pages/ORS.aspx', description: 'The Constitution of the State of Oregon.' },
      { law_type: 'statute', title: 'Oregon Revised Statutes', source_url: 'https://www.oregonlegislature.gov/bills_laws/Pages/ORS.aspx', description: 'Official Oregon Revised Statutes (ORS).' },
      { law_type: 'administrative_code', title: 'Oregon Administrative Rules', source_url: 'https://secure.sos.state.or.us/oard/displayChapterRules.action', description: 'Oregon Administrative Rules Compilation (OARS).' },
    ],
  },
  {
    abbr: 'PA', jurisdictionSlug: 'pennsylvania',
    entries: [
      { law_type: 'constitution', title: 'Pennsylvania Constitution', source_url: 'https://www.legis.state.pa.us/cfdocs/legis/LI/Public/cons_index.cfm', description: 'The Constitution of the Commonwealth of Pennsylvania.' },
      { law_type: 'statute', title: 'Pennsylvania Consolidated Statutes', source_url: 'https://www.legis.state.pa.us/cfdocs/legis/LI/Public/leg_index.cfm', description: 'Official Pennsylvania Consolidated Statutes (Pa.C.S.).' },
      { law_type: 'administrative_code', title: 'Pennsylvania Code', source_url: 'https://www.pacodeandbulletin.gov/', description: 'Pennsylvania Code (administrative regulations) and Pennsylvania Bulletin.' },
    ],
  },
  {
    abbr: 'RI', jurisdictionSlug: 'rhode-island',
    entries: [
      { law_type: 'constitution', title: 'Rhode Island Constitution', source_url: 'https://www.rilin.state.ri.us/RiConstitution/', description: 'The Constitution of the State of Rhode Island.' },
      { law_type: 'statute', title: 'General Laws of Rhode Island', source_url: 'https://www.rilegislature.gov/laws/rill.htm', description: 'Official General Laws of Rhode Island (RIGL).' },
      { law_type: 'administrative_code', title: 'Rhode Island Code of Regulations', source_url: 'https://rules.sos.ri.gov/', description: 'Rhode Island Code of Regulations.' },
    ],
  },
  {
    abbr: 'SC', jurisdictionSlug: 'south-carolina',
    entries: [
      { law_type: 'constitution', title: 'South Carolina Constitution', source_url: 'https://www.scstatehouse.gov/scconstitution/scconst.php', description: 'The Constitution of the State of South Carolina.' },
      { law_type: 'statute', title: 'South Carolina Code of Laws', source_url: 'https://www.scstatehouse.gov/coderegs/statmast.php', description: 'Official South Carolina Code of Laws.' },
      { law_type: 'administrative_code', title: 'South Carolina Code of Regulations', source_url: 'https://www.scstatehouse.gov/coderegs/regmast.php', description: 'South Carolina Code of Regulations.' },
    ],
  },
  {
    abbr: 'SD', jurisdictionSlug: 'south-dakota',
    entries: [
      { law_type: 'constitution', title: 'South Dakota Constitution', source_url: 'https://sdlegislature.gov/Statutes/Constitution', description: 'The Constitution of the State of South Dakota.' },
      { law_type: 'statute', title: 'South Dakota Codified Laws', source_url: 'https://sdlegislature.gov/Statutes', description: 'Official South Dakota Codified Laws (SDCL).' },
      { law_type: 'administrative_code', title: 'South Dakota Administrative Rules', source_url: 'https://sdlegislature.gov/Rules', description: 'South Dakota Administrative Rules (ARSD).' },
    ],
  },
  {
    abbr: 'TN', jurisdictionSlug: 'tennessee',
    entries: [
      { law_type: 'constitution', title: 'Tennessee Constitution', source_url: 'https://www.tn.gov/content/dam/tn/attorneygeneral/documents/Tennessee-Constitution-2017.pdf', description: 'The Constitution of the State of Tennessee.' },
      { law_type: 'statute', title: 'Tennessee Code Annotated', source_url: 'https://law.justia.com/codes/tennessee/', description: 'Official Tennessee Code Annotated (TCA).' },
      { law_type: 'administrative_code', title: 'Official Compilation of Rules and Regulations of the State of Tennessee', source_url: 'https://publications.tnsosfiles.com/rules/index.htm', description: 'Tennessee Rules and Regulations.' },
    ],
  },
  {
    abbr: 'TX', jurisdictionSlug: 'texas',
    entries: [
      { law_type: 'constitution', title: 'Texas Constitution', source_url: 'https://statutes.capitol.texas.gov/Docs/CN/htm/CN.1.htm', description: 'The Constitution of the State of Texas.' },
      { law_type: 'statute', title: 'Texas Statutes', source_url: 'https://statutes.capitol.texas.gov/', description: 'Official Texas Statutes maintained by the Texas Legislature.' },
      { law_type: 'administrative_code', title: 'Texas Administrative Code', source_url: 'https://texreg.sos.state.tx.us/public/readtac$ext.viewtac', description: 'Texas Administrative Code (TAC).' },
    ],
  },
  {
    abbr: 'UT', jurisdictionSlug: 'utah',
    entries: [
      { law_type: 'constitution', title: 'Utah Constitution', source_url: 'https://le.utah.gov/xcode/const.html', description: 'The Constitution of the State of Utah.' },
      { law_type: 'statute', title: 'Utah Code', source_url: 'https://le.utah.gov/xcode/code.html', description: 'Official Utah Code.' },
      { law_type: 'administrative_code', title: 'Utah Administrative Code', source_url: 'https://rules.utah.gov/publications/utah-adm-code/', description: 'Utah Administrative Code.' },
    ],
  },
  {
    abbr: 'VT', jurisdictionSlug: 'vermont',
    entries: [
      { law_type: 'constitution', title: 'Vermont Constitution', source_url: 'https://legislature.vermont.gov/statutes/const/', description: 'The Constitution of the State of Vermont.' },
      { law_type: 'statute', title: 'Vermont Statutes Annotated', source_url: 'https://legislature.vermont.gov/statutes/', description: 'Official Vermont Statutes Annotated (VSA).' },
      { law_type: 'administrative_code', title: 'Code of Vermont Rules', source_url: 'https://www.sec.state.vt.us/municipal-division/administrative-rules.aspx', description: 'Code of Vermont Rules.' },
    ],
  },
  {
    abbr: 'VA', jurisdictionSlug: 'virginia',
    entries: [
      { law_type: 'constitution', title: 'Constitution of Virginia', source_url: 'https://law.lis.virginia.gov/constitution/', description: 'The Constitution of the Commonwealth of Virginia.' },
      { law_type: 'statute', title: 'Code of Virginia', source_url: 'https://law.lis.virginia.gov/vacode/', description: 'Official Code of Virginia.' },
      { law_type: 'administrative_code', title: 'Virginia Administrative Code', source_url: 'https://law.lis.virginia.gov/admincode/', description: 'Virginia Administrative Code (VAC).' },
    ],
  },
  {
    abbr: 'WA', jurisdictionSlug: 'washington',
    entries: [
      { law_type: 'constitution', title: 'Washington State Constitution', source_url: 'https://leg.wa.gov/LawsAndAgencyRules/Pages/constitution.aspx', description: 'The Constitution of the State of Washington.' },
      { law_type: 'statute', title: 'Revised Code of Washington', source_url: 'https://app.leg.wa.gov/rcw/', description: 'Official Revised Code of Washington (RCW).' },
      { law_type: 'administrative_code', title: 'Washington Administrative Code', source_url: 'https://apps.leg.wa.gov/wac/', description: 'Washington Administrative Code (WAC).' },
    ],
  },
  {
    abbr: 'WV', jurisdictionSlug: 'west-virginia',
    entries: [
      { law_type: 'constitution', title: 'West Virginia Constitution', source_url: 'https://www.wvlegislature.gov/WVCODE/WV_CON.cfm', description: 'The Constitution of the State of West Virginia.' },
      { law_type: 'statute', title: 'West Virginia Code', source_url: 'https://www.wvlegislature.gov/WVCODE/Code.cfm', description: 'Official West Virginia Code (WV Code).' },
      { law_type: 'administrative_code', title: 'West Virginia Code of State Rules', source_url: 'https://apps.sos.wv.gov/adlaw/csr/', description: 'West Virginia Code of State Rules (CSR).' },
    ],
  },
  {
    abbr: 'WI', jurisdictionSlug: 'wisconsin',
    entries: [
      { law_type: 'constitution', title: 'Wisconsin Constitution', source_url: 'https://docs.legis.wisconsin.gov/document/statutes/Constitution', description: 'The Constitution of the State of Wisconsin.' },
      { law_type: 'statute', title: 'Wisconsin Statutes', source_url: 'https://docs.legis.wisconsin.gov/statutes/prefaces/toc', description: 'Official Wisconsin Statutes.' },
      { law_type: 'administrative_code', title: 'Wisconsin Administrative Code', source_url: 'https://docs.legis.wisconsin.gov/code/prefaces/toc', description: 'Wisconsin Administrative Code.' },
    ],
  },
  {
    abbr: 'WY', jurisdictionSlug: 'wyoming',
    entries: [
      { law_type: 'constitution', title: 'Wyoming Constitution', source_url: 'https://www.wyoleg.gov/StatIndex/Constitution', description: 'The Constitution of the State of Wyoming.' },
      { law_type: 'statute', title: 'Wyoming Statutes', source_url: 'https://www.wyoleg.gov/NXT/gateway.dll?f=templates&fn=default.htm', description: 'Official Wyoming Statutes.' },
      { law_type: 'administrative_code', title: 'Wyoming Rules and Regulations', source_url: 'https://rules.wyo.gov/', description: 'Wyoming Rules and Regulations.' },
    ],
  },
  {
    abbr: 'DC', jurisdictionSlug: 'district-of-columbia',
    entries: [
      { law_type: 'constitution', title: 'District of Columbia Home Rule Charter', source_url: 'https://code.dccouncil.gov/us/dc/council/code/sections/1-201.01', description: 'The District of Columbia Home Rule Charter, serving as the constitutional document for DC self-governance.' },
      { law_type: 'statute', title: 'District of Columbia Official Code', source_url: 'https://code.dccouncil.gov/us/dc/council/code/', description: 'Official District of Columbia Official Code.' },
      { law_type: 'administrative_code', title: 'District of Columbia Municipal Regulations', source_url: 'https://dcregs.dc.gov/', description: 'District of Columbia Municipal Regulations (DCMR).' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStateLawSources(): Promise<void> {
  console.log('=== Import State Law Sources ===\n');

  const totalEntries = STATE_LAW_SOURCES.reduce(
    (sum, s) => sum + s.entries.length,
    0,
  );
  console.log(
    `Processing ${STATE_LAW_SOURCES.length} jurisdictions / ${totalEntries} total entries …\n`,
  );

  // Cache jurisdiction slug → UUID to avoid repeated DB lookups.
  const jurisdictionCache = new Map<string, string>();

  let inserted = 0;
  let skipped = 0;

  for (const stateDef of STATE_LAW_SOURCES) {
    // Resolve jurisdiction_id.
    let jurisdictionId = jurisdictionCache.get(stateDef.jurisdictionSlug);

    if (!jurisdictionId) {
      const { data, error } = await supabase
        .from('jurisdictions')
        .select('id')
        .eq('slug', stateDef.jurisdictionSlug)
        .maybeSingle();

      if (error) {
        console.error(
          `  ${stateDef.abbr} — ERROR looking up jurisdiction: ${error.message}`,
        );
        skipped += stateDef.entries.length;
        continue;
      }

      if (!data) {
        console.warn(
          `  ${stateDef.abbr} — SKIP: jurisdiction not found (slug="${stateDef.jurisdictionSlug}")`,
        );
        skipped += stateDef.entries.length;
        continue;
      }

      jurisdictionId = (data as { id: string }).id;
      jurisdictionCache.set(stateDef.jurisdictionSlug, jurisdictionId);
    }

    console.log(`  ${stateDef.abbr} (${stateDef.entries.length} entries) …`);

    for (const entry of stateDef.entries) {
      const record: LawSourceInsert = {
        jurisdiction_id: jurisdictionId,
        law_type: entry.law_type,
        title: entry.title,
        source_url: entry.source_url,
        description: entry.description,
        api_url: entry.api_url ?? null,
      };

      const { error } = await supabase
        .from('law_sources')
        .upsert(record, { onConflict: 'source_url' });

      if (error) {
        console.error(`    ERROR "${entry.title}": ${error.message}`);
        skipped++;
      } else {
        process.stdout.write('.');
        inserted++;
      }
    }

    console.log(''); // newline after dots
  }

  console.log(
    `\n=== Completed. Inserted/updated: ${inserted}, skipped: ${skipped} ===`,
  );
}

importStateLawSources().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
