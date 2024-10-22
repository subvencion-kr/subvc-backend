import { MongoClient } from "mongodb";
import mongoose from "mongoose";
import axios from "axios";
import SubsidyModel from "../../models/subsidy.schema";
import { Subsidy, PaginationResult } from "./types/subsidy.type";

const {
  MONGODB_URI,
  DATABASE_NAME,
  COLLECTION_NAME,
  GOV24_API_KEY,
  OPENAI_API_KEY,
} = process.env;

export class SubsidyService {
  private mongoClient: MongoClient;
  private readonly DELAY_MS = 1000;
  private readonly MAX_RETRIES = 3;
  private readonly BATCH_SIZE = 10;

  constructor() {
    this.mongoClient = new MongoClient(`${MONGODB_URI}`);
    this.initialize();
  }
  private async initialize() {
    try {
      // MongoDB Native 연결 (벡터 검색용)
      // await this.mongoClient.connect();

      // Mongoose 연결 (일반 CRUD 작업용)
      await mongoose.connect(`${MONGODB_URI}/${DATABASE_NAME}`);

      console.log("Connections initialized");
      await this.createVectorSearchIndex();
    } catch (error) {
      console.error("Error initializing connections:", error);
      throw error;
    }
  }

  // Step 1: 전체 데이터 처리 프로세스
  async processAllData() {
    try {
      // 1. 기존 데이터 전체 삭제
      await this.clearAllData();

      // 2. 기본 정보 및 벡터 저장
      await this.fetchAndStoreBasicInfo();

      // 3. 지원자격 정보 업데이트
      await this.updateAllSupportConditions();

      // 4. 요약 정보 업데이트
      await this.updateAllSummaries();

      console.log("All data processing completed successfully");
    } catch (error) {
      console.error("Error in processAllData:", error);
      throw error;
    }
  }

  private async clearAllData() {
    try {
      await SubsidyModel.deleteMany({});
      console.log("All existing data cleared successfully");
    } catch (error) {
      console.error("Error clearing data:", error);
      throw error;
    }
  }

  private async fetchAndStoreBasicInfo() {
    try {
      const firstPageData = await this.fetchSubsidyPage(1, 1);
      const totalCount = firstPageData.totalCount;
      const perPage = 500;

      for (let page = 1; page <= Math.ceil(totalCount / perPage); page++) {
        const { data: subsidies } = await this.fetchSubsidyPage(page, perPage);

        for (let i = 0; i < subsidies.length; i += this.BATCH_SIZE) {
          const batch = subsidies.slice(i, i + this.BATCH_SIZE);
          await Promise.all(
            batch.map(async (subsidy: any) => {
              await this.saveBasicSubsidyInfo(subsidy);
            })
          );
          await this.delay(this.DELAY_MS);
        }
        console.log(`Processed page ${page} of basic info`);
      }
    } catch (error) {
      console.error("Error in fetchAndStoreBasicInfo:", error);
      throw error;
    }
  }

  private async updateAllSupportConditions() {
    try {
      const subsidies = await SubsidyModel.find({});

      for (const subsidy of subsidies) {
        try {
          const supportCondition = await this.fetchSupportConditionWithRetry(
            subsidy.serviceId
          );
          if (supportCondition) {
            const supportConditionArray =
              this.extractSupportConditions(supportCondition);
            subsidy.supportCondition = supportConditionArray;
            await subsidy.save();
          }
          await this.delay(this.DELAY_MS);
        } catch (error) {
          console.error(
            `Error updating support conditions for ${subsidy.serviceId}:`,
            error
          );
          continue;
        }
      }
    } catch (error) {
      console.error("Error in updateAllSupportConditions:", error);
      throw error;
    }
  }

  private async updateAllSummaries() {
    try {
      const subsidies = await SubsidyModel.find({});

      for (const subsidy of subsidies) {
        try {
          const summary = await this.summarizeContent(subsidy.supportDetails);
          const keywords = await this.extractKeywords(subsidy.serviceName);

          subsidy.summary = summary;
          subsidy.keywords = keywords;
          await subsidy.save();

          await this.delay(this.DELAY_MS);
        } catch (error) {
          console.error(
            `Error updating summaries for ${subsidy.serviceId}:`,
            error
          );
          continue;
        }
      }
    } catch (error) {
      console.error("Error in updateAllSummaries:", error);
      throw error;
    }
  }

  private async fetchSubsidyPage(page: number, perPage: number) {
    try {
      const response = await axios.get(
        "https://api.odcloud.kr/api/gov24/v3/serviceDetail",
        {
          params: { page, perPage, serviceKey: GOV24_API_KEY },
          headers: { Authorization: GOV24_API_KEY },
        }
      );
      return response.data;
    } catch (error) {
      console.error(`Error fetching subsidy page ${page}:`, error);
      throw error;
    }
  }

  private async fetchSupportConditionWithRetry(
    serviceId: string,
    retryCount = 0
  ): Promise<any> {
    try {
      return await this.fetchSupportCondition(serviceId);
    } catch (error: any) {
      if (retryCount < this.MAX_RETRIES && error.response?.data?.code === -10) {
        console.log(
          `Retrying fetchSupportCondition for serviceId ${serviceId} (attempt ${
            retryCount + 1
          })`
        );
        await this.delay(this.DELAY_MS * (retryCount + 1));
        return this.fetchSupportConditionWithRetry(serviceId, retryCount + 1);
      }
      throw error;
    }
  }

  private async fetchSupportCondition(serviceId: string) {
    try {
      const response = await axios.get(
        "https://api.odcloud.kr/api/gov24/v3/supportConditions",
        {
          params: {
            "cond[서비스ID::EQ]": serviceId,
            page: 1,
            perPage: 1,
            serviceKey: GOV24_API_KEY,
          },
          headers: { Authorization: GOV24_API_KEY },
        }
      );

      if (!response.data?.data || !Array.isArray(response.data.data)) {
        console.warn(`Invalid response format for serviceId ${serviceId}`);
        return null;
      }

      if (response.data.data.length === 0) {
        console.warn(
          `No support condition data found for serviceId ${serviceId}`
        );
        return null;
      }

      return response.data.data[0];
    } catch (error) {
      console.error(
        `Error fetching support condition for serviceId ${serviceId}:`,
        error
      );
      throw error;
    }
  }

  private async saveBasicSubsidyInfo(subsidyData: any) {
    try {
      const vectorEmbedding = await this.getEmbedding(subsidyData.서비스명);

      const subsidyDoc = new SubsidyModel({
        serviceId: subsidyData.서비스ID,
        supportType: subsidyData.지원유형,
        serviceName: subsidyData.서비스명,
        servicePurpose: subsidyData.서비스목적,
        applicationDeadline: subsidyData.신청기한,
        targetGroup: subsidyData.지원대상,
        selectionCriteria: subsidyData.선정기준,
        supportDetails: subsidyData.지원내용,
        applicationMethod: subsidyData.신청방법,
        requiredDocuments: subsidyData.구비서류,
        receptionInstitutionName: subsidyData.접수기관명,
        contactInfo: subsidyData.문의처,
        onlineApplicationUrl: subsidyData.온라인신청URL,
        lastModified: subsidyData.수정일시,
        responsibleInstitutionName: subsidyData.소관기관명,
        administrativeRules: subsidyData.행정규칙,
        localRegulations: subsidyData.자치법규,
        law: subsidyData.법령,
        supportCondition: [],
        vectorEmbedding,
        keywords: [],
        summary: "",
      });

      await subsidyDoc.save();

      console.log(
        `Basic subsidy data for service ${subsidyDoc.serviceId} saved successfully.`
      );
    } catch (error) {
      console.error("Error saving basic subsidy data:", error);
      throw error;
    }
  }

  private async getEmbedding(text: string): Promise<number[]> {
    try {
      const response = await axios.post(
        "https://api.openai.com/v1/embeddings",
        {
          input: text,
          model: "text-embedding-ada-002",
        },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      return response.data.data[0].embedding;
    } catch (error) {
      console.error("Error fetching embedding:", error);
      throw error;
    }
  }

  private extractSupportConditions(supportCondition: any): string[] {
    if (!supportCondition) return [];

    return Object.keys(supportCondition)
      .filter((key) => key.startsWith("JA"))
      .map((key) => supportCondition[key])
      .filter((condition) => condition != null);
  }

  private async summarizeContent(content: string): Promise<string> {
    try {
      const response = await axios.post(
        "http://localhost:5000/generate",
        {
          prompt: `Summarize the following content in 30 characters or less: ${content}`,
        },
        { headers: { "Content-Type": "application/json" } }
      );
      return response.data.trim();
    } catch (error) {
      console.error("Error summarizing content:", error);
      return "";
    }
  }

  private async extractKeywords(content: string): Promise<string[]> {
    try {
      const response = await axios.post(
        "http://localhost:5000/generate",
        {
          prompt: `Extract 15 key keywords from the following content: ${content}`,
        },
        { headers: { "Content-Type": "application/json" } }
      );
      return response.data.split(",").map((keyword: string) => keyword.trim());
    } catch (error) {
      console.error("Error extracting keywords:", error);
      return [];
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async createVectorSearchIndex() {
    const db = this.mongoClient.db(DATABASE_NAME);
    const collection = db.collection(COLLECTION_NAME || "subsidies");
    try {
      const indexes = await collection.listIndexes().toArray();
      const hasVectorIndex = indexes.some(
        (index) => index.name === "subsidy_vector_index"
      );

      if (!hasVectorIndex) {
        // MongoDB Atlas Search의 벡터 검색 인덱스 설정
        await collection.createIndex(
          {
            vectorEmbedding: 1, // 오름차순 또는 내림차순 (일반 인덱스의 방향 지정)
          },
          {
            name: "subsidy_vector_index",
          }
        );
        console.log("Vector search index created successfully.");
      } else {
        console.log("Vector search index already exists");
      }
    } catch (error) {
      console.error("Error creating vector search index:", error);
      throw error;
    }
  }

  // 검색 관련 메서드들...
  async searchSubsidiesByVector(
    query: string,
    page: number = 1,
    limit: number = 10
  ): Promise<PaginationResult<Subsidy>> {
    try {
      const queryVector = await this.getEmbedding(query);
      const skip = (page - 1) * limit;

      const db = this.mongoClient.db(DATABASE_NAME);
      const collection = db.collection<Subsidy>(COLLECTION_NAME || "subsidies");

      const pipeline = [
        {
          $vectorSearch: {
            queryVector: queryVector,
            path: "vectorEmbedding",
            numCandidates: 100,
            limit: 100,
            index: "subsidy_vector_index",
          },
        },
        {
          $project: {
            _id: 0,
            serviceId: 1,
            serviceName: 1,
            servicePurpose: 1,
            supportDetails: 1,
            keywords: 1,
            summary: 1,
            score: { $meta: "vectorSearchScore" },
          },
        },
        { $skip: skip },
        { $limit: limit },
      ];

      const results = await collection.aggregate<Subsidy>(pipeline).toArray();
      const totalCount = await collection.countDocuments();
      const totalPages = Math.ceil(totalCount / limit);

      return {
        results,
        pagination: {
          currentPage: page,
          totalPages,
          totalCount,
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      };
    } catch (error) {
      console.error("Error in vector search:", error);
      throw error;
    }
  }

  async close() {
    await Promise.all([this.mongoClient.close(), mongoose.disconnect()]);
  }
}
