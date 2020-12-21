require('dotenv').config()
const { ApolloServer, UserInputError, gql } = require('apollo-server')
const mongoose = require('mongoose')
const Book = require('./models/book')
const Author = require('./models/author')
const User = require('./models/user')
const jwt = require('jsonwebtoken')
const { PubSub } = require('apollo-server')
const pubsub = new PubSub()

const JWT_SECRET = process.env.JWT_SECRET

const MONGODB_URI = process.env.MONGODB_URI

console.log('connecting to', MONGODB_URI)

mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true, useFindAndModify: false, useCreateIndex: true })
    .then(() => {
        console.log('connected to MongoDB')
    })
    .catch((error) => {
        console.log('error connection to MongoDB:', error.message)
    })

const typeDefs = gql`
    type User {
        username: String!
        favoriteGenre: String!
        id: ID!
    }
    
    type Token {
        value: String!
    }

    type Author {
        name: String!
        born: Int
        books: [Book!]!
        id: ID!
    }

    type Book {
        title: String!
        author: Author!
        published: Int!
        genres: [String!]!
        id: ID!
    }

    type Query {
        bookCount: Int!
        authorCount: Int!
        allBooks(author: String, genre: String): [Book!]!
        allAuthors: [Author!]!
        me: User
    }

    type Mutation {
        addBook(
            title: String!
            author: String!
            published: Int
            genres: [String!]!
        ): Book
        editAuthor(
            name: String!
            setBornTo: Int!
        ): Author
        createUser(
            username: String!
            favoriteGenre: String!
        ): User
        login(
            username: String!
            password: String!
        ): Token
    }

    type Subscription {
        bookAdded: Book!
    }
`

const resolvers = {
    Query: {
        bookCount: () => Book.collection.countDocuments(),
        authorCount: () => Author.collection.countDocuments(),
        allBooks: (root, args) => {
            if (!args.genre) {
                return Book.find({}).populate("author")
            }

            return Book.find({ genres: { $in: [args.genre] } }).populate("author")
        },
        allAuthors: () => {
            console.log('allAuthors')
            return Author.find({}).populate('books')
        },
        me: (root, args, context) => context.currentUser
    },
    // Author: {
    //     bookCount: (root) => {
    //         console.log('Author.bookCount', root);
    //         // return Author.collection.countDocuments({ books: { $in: [root._id] } })
    //     }
    // },
    // Book: {
    //     author: async (root) => {
    //         console.log('Book.author')
    //         const author = await Author.findById(root.author)
    //         return author
    //     }
    // },
    Mutation: {
        addBook: async (root, args, context) => {
            console.log('args', args);
            if (!context.currentUser) {
                throw new UserInputError('Not authenticated')
            }

            let author = await Author.findOne({ name: args.author })

            if (!author) {
                author = new Author({ name: args.author })

                try {
                    await author.save()
                } catch (error) {
                    throw new UserInputError(error.message, {
                        InvalidArgs: args
                    })
                }
            }

            const book = new Book({ ...args, author: author._id })

            try {
                const addedBook = await book.save()

                author.books = [...author.books, addedBook._id]
                await author.save()
            } catch (error) {
                throw new UserInputError(error.message, {
                    InvalidArgs: args
                })
            }

            pubsub.publish('BOOK_ADDED', {
                bookAdded: {
                    ...book._doc,
                    id: book._doc._id,
                    author: { name: args.author }
                }
            })

            return {
                ...book._doc,
                id: book._doc._id,
                author: { name: args.author }
            }
        },
        editAuthor: async (root, args, context) => {
            if (!context.currentUser) {
                throw new UserInputError('Not authenticated')
            }

            let author = await Author.findOne({ name: args.name })

            if (!author) {
                return null
            }

            author.born = args.setBornTo

            try {
                await author.save()
            } catch (error) {
                throw new UserInputError(error.message, {
                    InvalidArgs: args
                })
            }

            return author
        },
        createUser: async (root, args) => {
            const user = new User({
                username: args.username,
                favoriteGenre: args.favoriteGenre
            })

            if (!user) {
                return null
            }

            try {
                await user.save()
            } catch (error) {
                throw new UserInputError(error.message, {
                    InvalidArgs: args
                })
            }

            return user
        },
        login: async (root, args) => {
            const user = await User.findOne({ username: args.username })

            if (!user || args.password !== 'salainen') {
                throw new UserInputError('Wrong credentials')
            }

            const token = jwt.sign({
                username: user.username,
                id: user._id,
            }, JWT_SECRET)

            return { value: token }
        }
    },
    Subscription: {
        bookAdded: {
            subscribe: () => pubsub.asyncIterator(['BOOK_ADDED'])
        }
    }
}

const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: async ({ req }) => {
        const auth = req ? req.headers.authorization : null
        if (auth && auth.toLowerCase().startsWith('bearer ')) {
            const decodedToken = jwt.verify(
                auth.substring(7), JWT_SECRET
            )
            const currentUser = await User.findById(decodedToken.id)
            return { currentUser }
        }
    }
})

server.listen().then(({ url, subscriptionsUrl }) => {
    console.log(`Server ready at ${url}`)
    console.log(`Subscriptions ready at ${subscriptionsUrl}`)
})