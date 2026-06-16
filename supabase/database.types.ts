// Crossroads — generated database types (Supabase project: rgbgstcipidkrcjofins)
// Regenerate after schema changes with:  supabase gen types typescript --project-id rgbgstcipidkrcjofins
// Use:  import type { Database, Tables, Enums } from './database.types'
//       const supabase = createClient<Database>(url, key)

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; display_name: string | null; avatar_url: string | null; created_at: string; updated_at: string }
        Insert: { id: string; display_name?: string | null; avatar_url?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; display_name?: string | null; avatar_url?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      teams: {
        Row: { id: string; owner_id: string; name: string; slug: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; owner_id: string; name: string; slug?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; owner_id?: string; name?: string; slug?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      team_members: {
        Row: { team_id: string; user_id: string; role: Database["public"]["Enums"]["team_role"]; created_at: string }
        Insert: { team_id: string; user_id: string; role?: Database["public"]["Enums"]["team_role"]; created_at?: string }
        Update: { team_id?: string; user_id?: string; role?: Database["public"]["Enums"]["team_role"]; created_at?: string }
        Relationships: [{ foreignKeyName: "team_members_team_id_fkey"; columns: ["team_id"]; referencedRelation: "teams"; referencedColumns: ["id"] }]
      }
      decisions: {
        Row: { id: string; owner_id: string; team_id: string | null; title: string; description: string | null; status: Database["public"]["Enums"]["decision_status"]; mode: string; risk: number; trials: number; visibility: Database["public"]["Enums"]["visibility"]; share_token: string | null; decided_option_id: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; owner_id?: string; team_id?: string | null; title: string; description?: string | null; status?: Database["public"]["Enums"]["decision_status"]; mode?: string; risk?: number; trials?: number; visibility?: Database["public"]["Enums"]["visibility"]; share_token?: string | null; decided_option_id?: string | null; created_at?: string; updated_at?: string }
        Update: Partial<Database["public"]["Tables"]["decisions"]["Insert"]>
        Relationships: []
      }
      options: {
        Row: { id: string; decision_id: string; name: string; position: number; created_at: string }
        Insert: { id?: string; decision_id: string; name: string; position?: number; created_at?: string }
        Update: Partial<Database["public"]["Tables"]["options"]["Insert"]>
        Relationships: [{ foreignKeyName: "options_decision_id_fkey"; columns: ["decision_id"]; referencedRelation: "decisions"; referencedColumns: ["id"] }]
      }
      criteria: {
        Row: { id: string; decision_id: string; name: string; uncertainty: Database["public"]["Enums"]["uncertainty_level"]; default_weight: number; position: number; created_at: string }
        Insert: { id?: string; decision_id: string; name: string; uncertainty?: Database["public"]["Enums"]["uncertainty_level"]; default_weight?: number; position?: number; created_at?: string }
        Update: Partial<Database["public"]["Tables"]["criteria"]["Insert"]>
        Relationships: [{ foreignKeyName: "criteria_decision_id_fkey"; columns: ["decision_id"]; referencedRelation: "decisions"; referencedColumns: ["id"] }]
      }
      decision_participants: {
        Row: { id: string; decision_id: string; user_id: string | null; display_name: string | null; invite_email: string | null; role: Database["public"]["Enums"]["participant_role"]; status: string; created_at: string }
        Insert: { id?: string; decision_id: string; user_id?: string | null; display_name?: string | null; invite_email?: string | null; role?: Database["public"]["Enums"]["participant_role"]; status?: string; created_at?: string }
        Update: Partial<Database["public"]["Tables"]["decision_participants"]["Insert"]>
        Relationships: [{ foreignKeyName: "decision_participants_decision_id_fkey"; columns: ["decision_id"]; referencedRelation: "decisions"; referencedColumns: ["id"] }]
      }
      input_weights: {
        Row: { decision_id: string; participant_id: string; criterion_id: string; weight: number; updated_at: string }
        Insert: { decision_id: string; participant_id: string; criterion_id: string; weight?: number; updated_at?: string }
        Update: Partial<Database["public"]["Tables"]["input_weights"]["Insert"]>
        Relationships: []
      }
      input_scores: {
        Row: { decision_id: string; participant_id: string; option_id: string; criterion_id: string; likely: number; updated_at: string }
        Insert: { decision_id: string; participant_id: string; option_id: string; criterion_id: string; likely: number; updated_at?: string }
        Update: Partial<Database["public"]["Tables"]["input_scores"]["Insert"]>
        Relationships: []
      }
      simulations: {
        Row: { id: string; decision_id: string; participant_id: string | null; kind: Database["public"]["Enums"]["sim_kind"]; aggregation: Database["public"]["Enums"]["aggregation_method"]; seed: number; trials: number; engine_version: string; status: Database["public"]["Enums"]["sim_status"]; result: Json | null; error: string | null; created_by: string | null; created_at: string; completed_at: string | null }
        Insert: { id?: string; decision_id: string; participant_id?: string | null; kind?: Database["public"]["Enums"]["sim_kind"]; aggregation?: Database["public"]["Enums"]["aggregation_method"]; seed: number; trials?: number; engine_version?: string; status?: Database["public"]["Enums"]["sim_status"]; result?: Json | null; error?: string | null; created_by?: string | null; created_at?: string; completed_at?: string | null }
        Update: Partial<Database["public"]["Tables"]["simulations"]["Insert"]>
        Relationships: [{ foreignKeyName: "simulations_decision_id_fkey"; columns: ["decision_id"]; referencedRelation: "decisions"; referencedColumns: ["id"] }]
      }
      decision_records: {
        Row: { id: string; decision_id: string; simulation_id: string | null; title: string | null; format: string; storage_path: string | null; public_token: string | null; created_by: string | null; created_at: string }
        Insert: { id?: string; decision_id: string; simulation_id?: string | null; title?: string | null; format?: string; storage_path?: string | null; public_token?: string | null; created_by?: string | null; created_at?: string }
        Update: Partial<Database["public"]["Tables"]["decision_records"]["Insert"]>
        Relationships: []
      }
      templates: {
        Row: { id: string; slug: string; title: string; description: string | null; category: string | null; is_official: boolean; author_id: string | null; payload: Json; usage_count: number; created_at: string }
        Insert: { id?: string; slug: string; title: string; description?: string | null; category?: string | null; is_official?: boolean; author_id?: string | null; payload: Json; usage_count?: number; created_at?: string }
        Update: Partial<Database["public"]["Tables"]["templates"]["Insert"]>
        Relationships: []
      }
      decision_outcomes: {
        Row: { id: string; decision_id: string; chosen_option_id: string | null; decided_at: string; predicted_pbest: number | null; expected_score: number | null; review_due: string | null; outcome_rating: number | null; reflection: string | null; reviewed_at: string | null; created_by: string | null }
        Insert: { id?: string; decision_id: string; chosen_option_id?: string | null; decided_at?: string; predicted_pbest?: number | null; expected_score?: number | null; review_due?: string | null; outcome_rating?: number | null; reflection?: string | null; reviewed_at?: string | null; created_by?: string | null }
        Update: Partial<Database["public"]["Tables"]["decision_outcomes"]["Insert"]>
        Relationships: []
      }
      subscriptions: {
        Row: { id: string; user_id: string | null; team_id: string | null; plan: Database["public"]["Enums"]["plan_type"]; status: string; seats: number; stripe_customer_id: string | null; stripe_subscription_id: string | null; current_period_end: string | null; updated_at: string }
        Insert: { id?: string; user_id?: string | null; team_id?: string | null; plan?: Database["public"]["Enums"]["plan_type"]; status?: string; seats?: number; stripe_customer_id?: string | null; stripe_subscription_id?: string | null; current_period_end?: string | null; updated_at?: string }
        Update: Partial<Database["public"]["Tables"]["subscriptions"]["Insert"]>
        Relationships: []
      }
    }
    Views: Record<never, never>
    Functions: {
      can_edit_decision: { Args: { p_decision: string }; Returns: boolean }
      can_read_decision: { Args: { p_decision: string }; Returns: boolean }
      is_team_admin: { Args: { p_team: string }; Returns: boolean }
      is_team_member: { Args: { p_team: string }; Returns: boolean }
      owns_participant: { Args: { p_participant: string }; Returns: boolean }
      shares_team_with: { Args: { p_user: string }; Returns: boolean }
    }
    Enums: {
      aggregation_method: "individual" | "mean" | "median" | "consensus"
      decision_status: "draft" | "active" | "decided" | "archived"
      participant_role: "owner" | "facilitator" | "contributor" | "viewer"
      plan_type: "free" | "pro" | "team"
      sim_kind: "individual" | "group"
      sim_status: "queued" | "running" | "done" | "error"
      team_role: "admin" | "member"
      uncertainty_level: "low" | "med" | "high"
      visibility: "private" | "team" | "link"
    }
  }
}

export type Tables<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"]
export type Enums<T extends keyof Database["public"]["Enums"]> = Database["public"]["Enums"][T]
