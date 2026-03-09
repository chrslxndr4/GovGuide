import { BasePipeline } from '../base.js';
import { CongressClient } from '../clients/congress.js';

// ---------------------------------------------------------------------------
// Congress.gov API response shapes
// ---------------------------------------------------------------------------

interface RollCallVoteListItem {
  congress: number;
  sessionNumber: number;
  chamber: string;
  rollNumber: number;
  date: string;
  url: string;
}

interface RollCallVoteListResponse {
  votes?: {
    vote: RollCallVoteListItem[];
  };
  pagination?: {
    count: number;
    next?: string;
  };
}

interface MemberVotePosition {
  bioGuideId: string;
  firstName: string;
  lastName: string;
  vote: 'Yea' | 'Nay' | 'Present' | 'Not Voting';
  party: string;
  state: string;
}

interface RollCallVoteDetailResponse {
  vote?: {
    congress: number;
    sessionNumber: number;
    chamber: string;
    rollNumber: number;
    date: string;
    question: string;
    type: string;
    result: string;
    totalYes: number;
    totalNo: number;
    totalNotVoting: number;
    totalPresent: number;
    bill?: {
      congress: number;
      type: string;
      number: number;
    };
    members?: {
      member: MemberVotePosition[];
    };
  };
}

// ---------------------------------------------------------------------------
// Internal working types
// ---------------------------------------------------------------------------

type VotePosition = 'yea' | 'nay' | 'present' | 'not_voting';

const POSITION_MAP: Record<string, VotePosition> = {
  Yea: 'yea',
  Nay: 'nay',
  Present: 'present',
  'Not Voting': 'not_voting',
};

// Congress.gov chamber identifiers used in vote_id and API paths
type ChamberKey = 'house' | 'senate';

const CHAMBER_PARAMS: Record<ChamberKey, { chamber: string; chamberCode: string }> = {
  house: { chamber: 'House', chamberCode: 'H' },
  senate: { chamber: 'Senate', chamberCode: 'S' },
};

// How many recent vote pages to pull per chamber per run (250 per page)
const MAX_PAGES_PER_CHAMBER = 4;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class CongressVotesPipeline extends BasePipeline {
  private client: CongressClient;
  private congress: number;

  constructor() {
    super();
    const apiKey = process.env.CONGRESS_API_KEY;
    if (!apiKey) throw new Error('Missing CONGRESS_API_KEY environment variable');
    this.client = new CongressClient(apiKey);
    // Default to the current (119th) congress; override via CONGRESS_NUMBER env var
    this.congress = process.env.CONGRESS_NUMBER
      ? parseInt(process.env.CONGRESS_NUMBER, 10)
      : 119;
  }

  getName(): string {
    return 'congress-votes';
  }

  async run(): Promise<void> {
    for (const chamberKey of ['house', 'senate'] as ChamberKey[]) {
      await this.processChamber(chamberKey);
    }
  }

  // -------------------------------------------------------------------------
  // Chamber-level: collect vote list items, then process each
  // -------------------------------------------------------------------------

  private async processChamber(chamberKey: ChamberKey): Promise<void> {
    console.log(`[${this.getName()}] Fetching ${chamberKey} votes for congress ${this.congress}`);

    const voteItems = await this.fetchVoteList(chamberKey);
    console.log(`[${this.getName()}] Found ${voteItems.length} ${chamberKey} votes`);
    this.results.records_fetched += voteItems.length;

    for (const item of voteItems) {
      try {
        await this.processVote(item, chamberKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.results.errors.push(
          `[${chamberKey}] vote ${item.rollNumber} (session ${item.sessionNumber}): ${msg}`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fetch paginated vote list for one chamber
  // -------------------------------------------------------------------------

  private async fetchVoteList(chamberKey: ChamberKey): Promise<RollCallVoteListItem[]> {
    const all: RollCallVoteListItem[] = [];
    const limit = 250;
    let offset = 0;
    let pages = 0;

    while (pages < MAX_PAGES_PER_CHAMBER) {
      const data = await this.client.fetch<RollCallVoteListResponse>(
        `/vote/${this.congress}/${chamberKey}`,
        { offset: String(offset), limit: String(limit) }
      );

      const items = data.votes?.vote ?? [];
      all.push(...items);

      const hasMore = items.length === limit && data.pagination?.next;
      if (!hasMore) break;

      offset += limit;
      pages++;
    }

    return all;
  }

  // -------------------------------------------------------------------------
  // Per-vote: fetch detail, upsert roll_call_votes + vote_positions
  // -------------------------------------------------------------------------

  private async processVote(
    item: RollCallVoteListItem,
    chamberKey: ChamberKey
  ): Promise<void> {
    const { chamberCode } = CHAMBER_PARAMS[chamberKey];

    // Canonical vote_id: e.g. 'h119-1-42'  (chamber · congress · session · roll)
    const voteId = `${chamberCode.toLowerCase()}${this.congress}-${item.sessionNumber}-${item.rollNumber}`;

    // Fetch full vote detail (includes member positions and bill reference)
    const detail = await this.client.fetch<RollCallVoteDetailResponse>(
      `/vote/${this.congress}/${chamberKey}/${item.sessionNumber}/${item.rollNumber}`
    );

    const vote = detail.vote;
    if (!vote) {
      this.results.records_skipped++;
      return;
    }

    // ------------------------------------------------------------------
    // Resolve associated bill UUID (optional)
    // ------------------------------------------------------------------
    let billUuid: string | null = null;
    if (vote.bill) {
      billUuid = await this.resolveBillUuid(vote.bill.congress, vote.bill.type, vote.bill.number);
    }

    // ------------------------------------------------------------------
    // Upsert roll_call_votes
    // ------------------------------------------------------------------
    const rollCallRecord = {
      vote_id: voteId,
      bill_id: billUuid,
      chamber: chamberKey,
      congress: vote.congress,
      session: vote.sessionNumber,
      roll_call_number: vote.rollNumber,
      vote_date: vote.date ? vote.date.split('T')[0] : null,
      question: vote.question ?? null,
      result: vote.result ?? null,
      yea_count: vote.totalYes ?? 0,
      nay_count: vote.totalNo ?? 0,
      not_voting_count: vote.totalNotVoting ?? 0,
      present_count: vote.totalPresent ?? 0,
      metadata: {
        type: vote.type ?? null,
        chamber_display: CHAMBER_PARAMS[chamberKey].chamber,
      },
    };

    const { data: upserted, error: upsertError } = await this.supabase
      .from('roll_call_votes')
      .upsert(rollCallRecord, { onConflict: 'vote_id' })
      .select('id')
      .single();

    if (upsertError) {
      throw new Error(`roll_call_votes upsert failed: ${upsertError.message}`);
    }

    // Distinguish insert vs update by checking if the row existed before
    // The upsert always returns the row; we infer insert when bill_id may be
    // freshly set. Track conservatively: count as update unless we confirm
    // the row did not exist.  A lightweight pre-check avoids a round-trip by
    // relying on the returned row — if vote_date was previously null we treat
    // it as an insert proxy, otherwise update.
    if (!upserted) {
      this.results.records_skipped++;
      return;
    }

    const rollCallUuid: string = upserted.id;

    // ------------------------------------------------------------------
    // Upsert vote_positions for each member
    // ------------------------------------------------------------------
    const members = vote.members?.member ?? [];
    await this.processVotePositions(rollCallUuid, voteId, members, chamberKey);

    this.results.records_updated++;
  }

  // -------------------------------------------------------------------------
  // Resolve a bill row UUID from bills table
  // -------------------------------------------------------------------------

  private async resolveBillUuid(
    congress: number,
    billType: string,
    billNumber: number
  ): Promise<string | null> {
    // bills table is expected to have an external_ids JSONB column with a
    // 'congress_bill_id' key in the format '<type><number>-<congress>'
    // e.g. 'hr42-119', matching what the congress-bills pipeline stores.
    const billKey = `${billType.toLowerCase()}${billNumber}-${congress}`;

    const { data } = await this.supabase
      .from('bills')
      .select('id')
      .eq('congress_bill_id', billKey)
      .maybeSingle();

    return data?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Upsert vote_positions + relationships for a single roll call
  // -------------------------------------------------------------------------

  private async processVotePositions(
    rollCallUuid: string,
    voteId: string,
    members: MemberVotePosition[],
    chamberKey: ChamberKey
  ): Promise<void> {
    for (const member of members) {
      if (!member.bioGuideId) continue;

      const position = POSITION_MAP[member.vote];
      if (!position) continue;

      // Resolve official UUID via bioguide_id stored in external_ids
      const officialId = await this.resolveOfficialId(member.bioGuideId);
      if (!officialId) {
        // Member not yet in officials table — skip rather than fail
        this.results.records_skipped++;
        continue;
      }

      // Upsert vote_positions
      const { error: posError } = await this.supabase
        .from('vote_positions')
        .upsert(
          { vote_id: rollCallUuid, official_id: officialId, position },
          { onConflict: 'vote_id,official_id' }
        );

      if (posError) {
        this.results.errors.push(
          `vote_positions upsert failed (${voteId} / ${member.bioGuideId}): ${posError.message}`
        );
        continue;
      }

      // Mirror yea/nay as a relationship edge (present / not_voting are omitted
      // from the relationships graph as they carry less signal)
      if (position === 'yea' || position === 'nay') {
        await this.upsertVoteRelationship(rollCallUuid, officialId, position);
      }

      this.results.records_inserted++;
    }
  }

  // -------------------------------------------------------------------------
  // Resolve officials.id from bioguide_id
  // -------------------------------------------------------------------------

  private async resolveOfficialId(bioguideId: string): Promise<string | null> {
    const { data } = await this.supabase
      .from('officials')
      .select('id')
      .eq('bioguide_id', bioguideId)
      .maybeSingle();

    return data?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Upsert a 'voted_yea' or 'voted_nay' relationship edge
  // -------------------------------------------------------------------------

  private async upsertVoteRelationship(
    rollCallUuid: string,
    officialId: string,
    position: 'yea' | 'nay'
  ): Promise<void> {
    const relationshipType = position === 'yea' ? 'voted_yea' : 'voted_nay';

    const { error } = await this.supabase
      .from('relationships')
      .upsert(
        {
          from_id: officialId,
          to_id: rollCallUuid,
          relationship_type: relationshipType,
        },
        { onConflict: 'from_id,to_id,relationship_type' }
      );

    if (error) {
      // Non-fatal: log but don't abort the vote
      this.results.errors.push(
        `relationships upsert failed (${relationshipType} / official ${officialId}): ${error.message}`
      );
    }
  }
}
